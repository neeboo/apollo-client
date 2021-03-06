import {
  ModifiableWatchQueryOptions,
  WatchQueryOptions,
  FetchMoreQueryOptions,
  SubscribeToMoreOptions,
} from './watchQueryOptions';

import { Observable, Observer, Subscription } from '../util/Observable';

import {
  QueryScheduler,
} from '../scheduler/scheduler';

import {
  ApolloError,
} from '../errors/ApolloError';

import {
  QueryManager,
} from './QueryManager';

import {
  ApolloQueryResult,
  FetchType,
} from './types';

import { tryFunctionOrLogError } from '../util/errorHandling';

import { isEqual } from '../util/isEqual';

import {
  NetworkStatus,
  isNetworkRequestInFlight,
 } from '../queries/networkStatus';

export type ApolloCurrentResult<T> = {
  data: T | {};
  loading: boolean;
  networkStatus: NetworkStatus;
  error?: ApolloError;
  partial?: boolean;
};

export interface FetchMoreOptions {
  updateQuery: (previousQueryResult: Object, options: {
    fetchMoreResult: Object,
    queryVariables: Object,
  }) => Object;
}

export interface UpdateQueryOptions {
  variables?: Object;
}

export class ObservableQuery<T> extends Observable<ApolloQueryResult<T>> {
  public options: WatchQueryOptions;
  public queryId: string;
  /**
   *
   * The current value of the variables for this query. Can change.
   */
  public variables: { [key: string]: any };

  private isCurrentlyPolling: boolean;
  private shouldSubscribe: boolean;
  private scheduler: QueryScheduler;
  private queryManager: QueryManager;
  private observers: Observer<ApolloQueryResult<T>>[];
  private subscriptionHandles: Subscription[];

  private lastResult: ApolloQueryResult<T>;
  private lastError: ApolloError;

  constructor({
    scheduler,
    options,
    shouldSubscribe = true,
  }: {
    scheduler: QueryScheduler,
    options: WatchQueryOptions,
    shouldSubscribe?: boolean,
  }) {
    const queryManager = scheduler.queryManager;
    const queryId = queryManager.generateQueryId();

    const subscriberFunction = (observer: Observer<ApolloQueryResult<T>>) => {
      return this.onSubscribe(observer);
    };

    super(subscriberFunction);

    this.isCurrentlyPolling = false;
    this.options = options;
    this.variables = this.options.variables || {};
    this.scheduler = scheduler;
    this.queryManager = queryManager;
    this.queryId = queryId;
    this.shouldSubscribe = shouldSubscribe;
    this.observers = [];
    this.subscriptionHandles = [];
  }

  public result(): Promise<ApolloQueryResult<T>> {
    return new Promise((resolve, reject) => {
      const subscription = this.subscribe({
        next(result) {
          resolve(result);
          setTimeout(() => {
            subscription.unsubscribe();
          }, 0);
        },
        error(error) {
          reject(error);
        },
      });
    });
  }

  /**
   * Return the result of the query from the local cache as well as some fetching status
   * `loading` and `networkStatus` allow to know if a request is in flight
   * `partial` lets you know if the result from the local cache is complete or partial
   * @return {result: Object, loading: boolean, networkStatus: number, partial: boolean}
   */
  public currentResult(): ApolloCurrentResult<T> {
    const { data, partial } = this.queryManager.getCurrentQueryResult(this, true);
    const queryStoreValue = this.queryManager.getApolloState().queries[this.queryId];

    if (queryStoreValue && (
      (queryStoreValue.graphQLErrors && queryStoreValue.graphQLErrors.length > 0) ||
      queryStoreValue.networkError
    )) {
      const error = new ApolloError({
        graphQLErrors: queryStoreValue.graphQLErrors,
        networkError: queryStoreValue.networkError,
      });
      return { data: {}, loading: false, networkStatus: queryStoreValue.networkStatus, error };
    }

    const queryLoading = !queryStoreValue || queryStoreValue.networkStatus === NetworkStatus.loading;

    // We need to be careful about the loading state we show to the user, to try
    // and be vaguely in line with what the user would have seen from .subscribe()
    // but to still provide useful information synchronously when the query
    // will not end up hitting the server.
    // See more: https://github.com/apollostack/apollo-client/issues/707
    // Basically: is there a query in flight right now (modolo the next tick)?
    const loading = (this.options.forceFetch && queryLoading)
      || (partial && !this.options.noFetch);

    // if there is nothing in the query store, it means this query hasn't fired yet. Therefore the
    // network status is dependent on queryLoading.
    // XXX querying the currentResult before having fired the query is kind of weird and makes our code a lot more complicated.
    let networkStatus: NetworkStatus;
    if (queryStoreValue) {
     networkStatus = queryStoreValue.networkStatus;
    } else {
      networkStatus = loading ? NetworkStatus.loading : NetworkStatus.ready;
    }

    return {
      data,
      loading: isNetworkRequestInFlight(networkStatus),
      networkStatus,
      partial,
    };
  }

  // Returns the last result that observer.next was called with. This is not the same as
  // currentResult! If you're not sure which you need, then you probably need currentResult.
  public getLastResult(): ApolloQueryResult<T> {
    return this.lastResult;
  }

  public refetch(variables?: any): Promise<ApolloQueryResult<T>> {
    this.variables = {
      ...this.variables,
      ...variables,
    };

    if (this.options.noFetch) {
      throw new Error('noFetch option should not use query refetch.');
    }

    // Update the existing options with new variables
    this.options.variables = {
      ...this.options.variables,
      ...this.variables,
    };

    // Override forceFetch for this call only
    const combinedOptions = {
      ...this.options,
      forceFetch: true,
    };

    return this.queryManager.fetchQuery(this.queryId, combinedOptions, FetchType.refetch)
      .then(result => this.queryManager.transformResult(result));
  }

  public fetchMore(
    fetchMoreOptions: FetchMoreQueryOptions & FetchMoreOptions,
  ): Promise<ApolloQueryResult<T>> {
    return Promise.resolve()
      .then(() => {
        const qid = this.queryManager.generateQueryId();
        let combinedOptions: any = null;

        if (fetchMoreOptions.query) {
          // fetch a new query
          combinedOptions = fetchMoreOptions;
        } else {
          // fetch the same query with a possibly new variables
          const variables = {
            ...this.variables,
            ...fetchMoreOptions.variables,
          };

          combinedOptions = {
            ...this.options,
            ...fetchMoreOptions,
            variables,
          };
        }

        combinedOptions = {
          ...combinedOptions,
          query: combinedOptions.query,
          forceFetch: true,
        } as WatchQueryOptions;
        return this.queryManager.fetchQuery(qid, combinedOptions);
      })
      .then((fetchMoreResult) => {
        const reducer = fetchMoreOptions.updateQuery;
        const mapFn = (previousResult: any, { variables }: {variables: any }) => {

          // TODO REFACTOR: reached max recursion depth (figuratively) when renaming queryVariables.
          // Continue renaming to variables further down when we have time.
          const queryVariables = variables;
          return reducer(
            previousResult, {
              fetchMoreResult,
              queryVariables,
            });
        };
        this.updateQuery(mapFn);
        return fetchMoreResult;
      });
  }

  // XXX the subscription variables are separate from the query variables.
  // if you want to update subscription variables, right now you have to do that separately,
  // and you can only do it by stopping the subscription and then subscribing again with new variables.
  public subscribeToMore(
    options: SubscribeToMoreOptions,
  ): () => void {
    const observable = this.queryManager.startGraphQLSubscription({
      document: options.document,
      variables: options.variables,
    });

    const reducer = options.updateQuery;

    const subscription = observable.subscribe({
      next: (data) => {
        const mapFn = (previousResult: Object, { variables }: { variables: Object }) => {
          return reducer(
            previousResult, {
              subscriptionData: { data },
              variables,
            },
          );
        };
        this.updateQuery(mapFn);
      },
      error: (err) => {
        if (options.onError) {
          options.onError(err);
        } else {
          console.error('Unhandled GraphQL subscription errror', err);
        }
      },
    });

    this.subscriptionHandles.push(subscription);

    return () => {
      const i = this.subscriptionHandles.indexOf(subscription);
      if (i >= 0) {
        this.subscriptionHandles.splice(i, 1);
        subscription.unsubscribe();
      }
    };
  }

  // Note: if the query is not active (there are no subscribers), the promise
  // will return null immediately.
  public setOptions(opts: ModifiableWatchQueryOptions): Promise<ApolloQueryResult<T>> {
    const oldOptions = this.options;
    this.options = {
      ...this.options,
      ...opts,
    } as WatchQueryOptions;

    if (opts.pollInterval) {
      this.startPolling(opts.pollInterval);
    } else if (opts.pollInterval === 0) {
      this.stopPolling();
    }

    // If forceFetch went from false to true or noFetch went from true to false
    const tryFetch: boolean = (!oldOptions.forceFetch && opts.forceFetch)
      || (oldOptions.noFetch && !opts.noFetch) || false;

    return this.setVariables(this.options.variables, tryFetch);
  }

  /**
   * Update the variables of this observable query, and fetch the new results
   * if they've changed. If you want to force new results, use `refetch`.
   *
   * Note: if the variables have not changed, the promise will return the old
   * results immediately, and the `next` callback will *not* fire.
   *
   * Note: if the query is not active (there are no subscribers), the promise
   * will return null immediately.
   *
   * @param variables: The new set of variables. If there are missing variables,
   * the previous values of those variables will be used.
   *
   * @param tryFetch: Try and fetch new results even if the variables haven't
   * changed (we may still just hit the store, but if there's nothing in there
   * this will refetch)
   */
  public setVariables(variables: any, tryFetch: boolean = false): Promise<ApolloQueryResult<T>> {
    const newVariables = {
      ...this.variables,
      ...variables,
    };

    if (isEqual(newVariables, this.variables) && !tryFetch) {
      // If we have no observers, then we don't actually want to make a network
      // request. As soon as someone observes the query, the request will kick
      // off. For now, we just store any changes. (See #1077)
      if (this.observers.length === 0) {
        return new Promise((resolve) => resolve());
      }

      return this.result();
    } else {
      this.variables = newVariables;

      // See comment above
      if (this.observers.length === 0) {
        return new Promise((resolve) => resolve());
      }

      // Use the same options as before, but with new variables
      return this.queryManager.fetchQuery(this.queryId, {
        ...this.options,
        variables: this.variables,
      } as WatchQueryOptions)
        .then(result => this.queryManager.transformResult(result));
    }
  }

  public updateQuery(
    mapFn: (previousQueryResult: any, options: UpdateQueryOptions) => any,
  ): void {
    const {
      previousResult,
      variables,
      document,
    } = this.queryManager.getQueryWithPreviousResult(this.queryId);

    const newResult = tryFunctionOrLogError(
      () => mapFn(previousResult, { variables }));

    if (newResult) {
      this.queryManager.store.dispatch({
        type: 'APOLLO_UPDATE_QUERY_RESULT',
        newResult,
        variables,
        document,
      });
    }
  }

  public stopPolling() {
    if (this.isCurrentlyPolling) {
      this.scheduler.stopPollingQuery(this.queryId);
      this.isCurrentlyPolling = false;
    }
  }

  public startPolling(pollInterval: number) {
    if (this.options.noFetch) {
      throw new Error('noFetch option should not use query polling.');
    }

    if (this.isCurrentlyPolling) {
      this.scheduler.stopPollingQuery(this.queryId);
      this.isCurrentlyPolling = false;
    }
    this.options.pollInterval = pollInterval;
    this.isCurrentlyPolling = true;
    this.scheduler.startPollingQuery(this.options, this.queryId);
  }

  private onSubscribe(observer: Observer<ApolloQueryResult<T>>) {
    this.observers.push(observer);

    // Deliver initial result
    if (observer.next && this.lastResult) {
      observer.next(this.lastResult);
    }

    if (observer.error && this.lastError) {
      observer.error(this.lastError);
    }

    if (this.observers.length === 1) {
      this.setUpQuery();
    }

    const retQuerySubscription = {
      unsubscribe: () => {
        if (this.observers.findIndex(el => el === observer) < 0 ) {
          // XXX can't unsubscribe if you've already unsubscribed...
          // for some reason unsubscribe gets called multiple times by some of the tests
          return;
        }
        this.observers = this.observers.filter((obs) => obs !== observer);

        if (this.observers.length === 0) {
          this.tearDownQuery();
        }
      },
    };

    return retQuerySubscription;
  }

  private setUpQuery() {
    if (this.shouldSubscribe) {
      this.queryManager.addObservableQuery<T>(this.queryId, this);
    }

    if (!!this.options.pollInterval) {
      if (this.options.noFetch) {
        throw new Error('noFetch option should not use query polling.');
      }

      this.isCurrentlyPolling = true;
      this.scheduler.startPollingQuery<T>(
        this.options,
        this.queryId,
      );
    }

    const observer: Observer<ApolloQueryResult<T>> = {
      next: (result: ApolloQueryResult<T>) => {
        this.lastResult = result;
        this.observers.forEach((obs) => {
          if (obs.next) {
            obs.next(result);
          }
        });
      },
      error: (error: ApolloError) => {
        this.observers.forEach((obs) => {
          if (obs.error) {
            obs.error(error);
          } else {
            console.error('Unhandled error', error.message, error.stack);
          }
        });

        this.lastError = error;
      },
    };

    this.queryManager.startQuery<T>(
      this.queryId,
      this.options,
      this.queryManager.queryListenerForObserver(this.queryId, this.options, observer),
    );
  }

  private tearDownQuery() {
    if (this.isCurrentlyPolling) {
      this.scheduler.stopPollingQuery(this.queryId);
      this.isCurrentlyPolling = false;
    }

    // stop all active GraphQL subscriptions
    this.subscriptionHandles.forEach( sub => sub.unsubscribe() );
    this.subscriptionHandles = [];

    this.queryManager.stopQuery(this.queryId);
    if (this.shouldSubscribe) {
      this.queryManager.removeObservableQuery(this.queryId);
    }
    this.observers = [];
  }
}
