/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule GraphQLQueryRunner
 * @typechecks
 * @flow
 */

'use strict';

var DliteFetchModeConstants = require('DliteFetchModeConstants');
import type {RelayQuerySet} from 'RelayInternalTypes';
import type {PendingFetch} from 'RelayPendingQueryTracker';
var RelayNetworkLayer = require('RelayNetworkLayer');
var RelayPendingQueryTracker = require('RelayPendingQueryTracker');
var RelayProfiler = require('RelayProfiler');
import type RelayQuery from 'RelayQuery';
var RelayStoreData = require('RelayStoreData');
var RelayTaskScheduler = require('RelayTaskScheduler');

var checkRelayQueryData = require('checkRelayQueryData');
var diffRelayQuery = require('diffRelayQuery');
var everyObject = require('everyObject');
var flattenSplitRelayQueries = require('flattenSplitRelayQueries');
var forEachObject = require('forEachObject');
var generateForceIndex = require('generateForceIndex');
var invariant = require('invariant');
var resolveImmediate = require('resolveImmediate');
var someObject = require('someObject');
var splitDeferredRelayQueries = require('splitDeferredRelayQueries');
var warning = require('warning');

import type {
  Abortable,
  ReadyStateChangeCallback
} from 'RelayTypes';

type PartialReadyState = {
  aborted?: boolean;
  done?: boolean;
  error?: Error;
  ready?: boolean;
  stale?: boolean;
};
type QueryRunnerProfiles = {
  done: RelayProfileHandler;
  initialize: RelayProfileHandler,
  ready: RelayProfileHandler;
};
type RelayProfileHandler = {stop: () => void};

// The source of truth for application data.
var storeData = RelayStoreData.getDefaultInstance();

/**
 * This is the high-level entry point for sending queries to the GraphQL
 * endpoint. It provides methods for scheduling queries (`run`), force-fetching
 * queries (ie. ignoring the cache; `forceFetch`).
 *
 * In order to send minimal queries and avoid re-retrieving data,
 * `GraphQLQueryRunner` maintains a registry of pending (in-flight) queries, and
 * "subtracts" those from any new queries that callers enqueue.
 *
 * @internal
 */
var GraphQLQueryRunner = {

  /**
   * Fetches data required to resolve a set of queries. See the `RelayStore`
   * module for documentation on the callback.
   *
   * Fetch mode must be a value in `DliteFetchModeConstants`.
   */
  run: function(
    querySet: RelayQuerySet,
    callback: ReadyStateChangeCallback,
    fetchMode?: string
  ): Abortable {
    fetchMode = fetchMode || DliteFetchModeConstants.FETCH_MODE_CLIENT;
    var profilers = createProfiles(fetchMode);

    var diffQueries = [];
    if (fetchMode === DliteFetchModeConstants.FETCH_MODE_CLIENT) {
      forEachObject(querySet, query => {
        if (query) {
          diffQueries.push(...diffRelayQuery(
            query,
            storeData.getRecordStore(),
            storeData.getQueryTracker()
          ));
        }
      });
    } else {
      forEachObject(querySet, query => {
        if (query) {
          diffQueries.push(query);
        }
      });
    }

    return runQueries(diffQueries, callback, fetchMode, profilers);
  },

  /**
   * Ignores the cache and fetches data required to resolve a set of queries.
   * Uses the data we get back from the server to overwrite data in the cache.
   *
   * Even though we're ignoring the cache, we will still invoke the callback
   * immediately with `ready: true` if `querySet` can be resolved by the cache.
   */
  forceFetch: function(
    querySet: RelayQuerySet,
    callback: ReadyStateChangeCallback
  ): Abortable {
    var fetchMode = DliteFetchModeConstants.FETCH_MODE_REFETCH;
    var profilers = createProfiles(fetchMode);
    var queries = [];
    forEachObject(querySet, query => {
      query && queries.push(query);
    });

    return runQueries(queries, callback, fetchMode, profilers);
  },

};

function canResolve(fetch: PendingFetch): boolean {
  return checkRelayQueryData(
    storeData.getQueuedStore(),
    fetch.getQuery()
  );
}

function hasItems(map: Object): boolean {
  return !!Object.keys(map).length;
}

function createProfiles(fetchMode: string): QueryRunnerProfiles {
  var profileName = fetchMode === DliteFetchModeConstants.FETCH_MODE_REFETCH ?
    'forceFetch' :
    'primeCache';
  return {
    done: RelayProfiler.profile(`GraphQLQueryRunner.${profileName}.done`),
    initialize: RelayProfiler.profile(`GraphQLQueryRunner.${profileName}`),
    ready: RelayProfiler.profile(`GraphQLQueryRunner.${profileName}.ready`),
  };
}

function splitAndFlattenQueries(
  queries: Array<RelayQuery.Root>
): Array<RelayQuery.Root> {
  if (!RelayNetworkLayer.supports('defer')) {
    var hasDeferredDescendant = queries.some(query => {
      if (query.hasDeferredDescendant()) {
        warning(
          false,
          'Relay: Query `%s` contains a deferred fragment (e.g. ' +
          '`getFragment(\'foo\').defer()`) which is not supported by the ' +
          'default network layer. This query will be sent without deferral.',
          query.getName()
        );
        return true;
      }
    });
    if (hasDeferredDescendant) {
      return queries;
    }
  }

  var flattenedQueries = [];
  queries.forEach(query => {
    return flattenedQueries.push(
      ...flattenSplitRelayQueries(
        splitDeferredRelayQueries(query)
      )
    );
  });
  return flattenedQueries;
}

function runQueries(
  queries: Array<RelayQuery.Root>,
  callback: ReadyStateChangeCallback,
  fetchMode: string,
  profilers: QueryRunnerProfiles
): Abortable {
  var readyState = {
    aborted: false,
    done: false,
    error: null,
    ready: false,
    stale: false,
  };
  var scheduled = false;
  function setReadyState(partial: PartialReadyState): void {
    if (readyState.aborted) {
      return;
    }
    if (readyState.done || readyState.error) {
      invariant(
        partial.aborted,
        'GraphQLQueryRunner: Unexpected ready state change.'
      );
      return;
    }
    if (partial.ready && !readyState.ready) {
      profilers.ready.stop();
    }
    if (partial.done && !readyState.done) {
      profilers.done.stop();
    }
    readyState = {
      aborted: partial.aborted != null ? partial.aborted : readyState.aborted,
      done: partial.done != null ? partial.done : readyState.done,
      error: partial.error != null ? partial.error : readyState.error,
      ready: partial.ready != null ? partial.ready : readyState.ready,
      stale: partial.stale != null ? partial.stale : readyState.stale,
    };
    if (scheduled) {
      return;
    }
    scheduled = true;
    resolveImmediate(() => {
      scheduled = false;
      callback(readyState);
    });
  }

  var remainingFetchMap: {[queryID: string]: PendingFetch} = {};
  var remainingRequiredFetchMap: {[queryID: string]: PendingFetch} = {};

  function onResolved(pendingFetch: PendingFetch) {
    var pendingQuery = pendingFetch.getQuery();
    var pendingQueryID = pendingQuery.getID();
    delete remainingFetchMap[pendingQueryID];
    if (!pendingQuery.isDeferred()) {
      delete remainingRequiredFetchMap[pendingQueryID];
    }

    if (hasItems(remainingRequiredFetchMap)) {
      return;
    }

    if (someObject(remainingFetchMap, query => query.isResolvable())) {
      // The other resolvable query will resolve imminently and call
      // `setReadyState` instead.
      return;
    }

    if (hasItems(remainingFetchMap)) {
      setReadyState({done: false, ready: true, stale: false});
    } else {
      setReadyState({done: true, ready: true, stale: false});
    }
  }

  function onRejected(pendingFetch: PendingFetch, error: Error) {
    setReadyState({error});

    var pendingQuery = pendingFetch.getQuery();
    var pendingQueryID = pendingQuery.getID();
    delete remainingFetchMap[pendingQueryID];
    if (!pendingQuery.isDeferred()) {
      delete remainingRequiredFetchMap[pendingQueryID];
    }
  }

  RelayTaskScheduler.await(() => {
    var forceIndex = fetchMode === DliteFetchModeConstants.FETCH_MODE_REFETCH ?
      generateForceIndex() : null;

    splitAndFlattenQueries(queries).forEach(query => {
      var pendingFetch = RelayPendingQueryTracker.add(
        {query, fetchMode, forceIndex, storeData}
      );
      var queryID = query.getID();
      remainingFetchMap[queryID] = pendingFetch;
      if (!query.isDeferred()) {
        remainingRequiredFetchMap[queryID] = pendingFetch;
      }
      pendingFetch.getResolvedPromise().then(
        onResolved.bind(null, pendingFetch),
        onRejected.bind(null, pendingFetch)
      );
    });

    if (!hasItems(remainingFetchMap)) {
      setReadyState({done: true, ready: true});
    } else {
      if (!hasItems(remainingRequiredFetchMap)) {
        setReadyState({ready: true});
      } else {
        setReadyState({ready: false});
        storeData.runWithDiskCache(() => {
          if (hasItems(remainingRequiredFetchMap)) {
            if (everyObject(remainingRequiredFetchMap, canResolve)) {
              setReadyState({ready: true, stale: true});
            }
          }
        });
      }
    }
  }).done();

  // Stop profiling when synchronous work has completed.
  profilers.initialize.stop();

  return {
    abort(): void {
      setReadyState({aborted: true});
    }
  };
}

module.exports = GraphQLQueryRunner;
