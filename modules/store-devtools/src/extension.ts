import { Inject, Injectable, InjectionToken } from '@angular/core';
import { Action } from '@ngrx/store';
import { Observable } from 'rxjs/Observable';
import { empty } from 'rxjs/observable/empty';
import { filter } from 'rxjs/operator/filter';
import { map } from 'rxjs/operator/map';
import { share } from 'rxjs/operator/share';
import { switchMap } from 'rxjs/operator/switchMap';
import { takeUntil } from 'rxjs/operator/takeUntil';

import {
  STORE_DEVTOOLS_CONFIG,
  StoreDevtoolsConfig,
  StateSanitizer,
} from './config';
import {
  LiftedState,
  LiftedActions,
  ComputedState,
  LiftedAction,
} from './reducer';
import { PerformAction, PERFORM_ACTION } from './actions';
import {
  applyOperators,
  unliftState,
  sanitizeState,
  sanitizeAction,
  sanitizeActions,
  sanitizeStates,
} from './utils';

export const ExtensionActionTypes = {
  START: 'START',
  DISPATCH: 'DISPATCH',
  STOP: 'STOP',
  ACTION: 'ACTION',
};

export const REDUX_DEVTOOLS_EXTENSION = new InjectionToken<
  ReduxDevtoolsExtension
>('Redux Devtools Extension');

export interface ReduxDevtoolsExtensionConnection {
  subscribe(listener: (change: any) => void): void;
  unsubscribe(): void;
  send(action: any, state: any): void;
  init(state?: any): void;
  error(any: any): void;
}
export interface ReduxDevtoolsExtensionConfig {
  features?: object | boolean;
  name: string | undefined;
  instanceId: string;
  maxAge?: number;
  serialize?: boolean;
}

export interface ReduxDevtoolsExtension {
  connect(
    options: ReduxDevtoolsExtensionConfig
  ): ReduxDevtoolsExtensionConnection;
  send(
    action: any,
    state: any,
    options: ReduxDevtoolsExtensionConfig,
    instanceId?: string
  ): void;
}

@Injectable()
export class DevtoolsExtension {
  private instanceId = `ngrx-store-${Date.now()}`;
  private devtoolsExtension: ReduxDevtoolsExtension;
  private extensionConnection!: ReduxDevtoolsExtensionConnection;

  liftedActions$!: Observable<any>;
  actions$!: Observable<any>;

  constructor(
    @Inject(REDUX_DEVTOOLS_EXTENSION) devtoolsExtension: ReduxDevtoolsExtension,
    @Inject(STORE_DEVTOOLS_CONFIG) private config: StoreDevtoolsConfig
  ) {
    this.devtoolsExtension = devtoolsExtension;
    this.createActionStreams();
  }

  notify(action: LiftedAction, state: LiftedState) {
    if (!this.devtoolsExtension) {
      return;
    }

    // Check to see if the action requires a full update of the liftedState.
    // If it is a simple action generated by the user's app, only send the
    // action and the current state (fast).
    //
    // A full liftedState update (slow: serializes the entire liftedState) is
    // only required when:
    //   a) redux-devtools-extension fires the @@Init action (ignored by
    //      @ngrx/store-devtools)
    //   b) an action is generated by an @ngrx module (e.g. @ngrx/effects/init
    //      or @ngrx/store/update-reducers)
    //   c) the state has been recomputed due to time-traveling
    //   d) any action that is not a PerformAction to err on the side of
    //      caution.
    if (action.type === PERFORM_ACTION) {
      const currentState = unliftState(state);
      const sanitizedState = this.config.stateSanitizer
        ? sanitizeState(
            this.config.stateSanitizer,
            currentState,
            state.currentStateIndex
          )
        : currentState;
      const sanitizedAction = this.config.actionSanitizer
        ? sanitizeAction(
            this.config.actionSanitizer,
            action,
            state.nextActionId
          )
        : action;
      this.extensionConnection.send(sanitizedAction, sanitizedState);
    } else {
      // Requires full state update
      const sanitizedLiftedState = {
        ...state,
        actionsById: this.config.actionSanitizer
          ? sanitizeActions(this.config.actionSanitizer, state.actionsById)
          : state.actionsById,
        computedStates: this.config.stateSanitizer
          ? sanitizeStates(this.config.stateSanitizer, state.computedStates)
          : state.computedStates,
      };
      this.devtoolsExtension.send(
        null,
        sanitizedLiftedState,
        this.getExtensionConfig(this.instanceId, this.config),
        this.instanceId
      );
    }
  }

  private createChangesObservable(): Observable<any> {
    if (!this.devtoolsExtension) {
      return empty();
    }

    return new Observable(subscriber => {
      const connection = this.devtoolsExtension.connect(
        this.getExtensionConfig(this.instanceId, this.config)
      );
      this.extensionConnection = connection;
      connection.init();

      connection.subscribe((change: any) => subscriber.next(change));
      return connection.unsubscribe;
    });
  }

  private createActionStreams() {
    // Listens to all changes based on our instanceId
    const changes$ = share.call(this.createChangesObservable());

    // Listen for the start action
    const start$ = filter.call(
      changes$,
      (change: any) => change.type === ExtensionActionTypes.START
    );

    // Listen for the stop action
    const stop$ = filter.call(
      changes$,
      (change: any) => change.type === ExtensionActionTypes.STOP
    );

    // Listen for lifted actions
    const liftedActions$ = applyOperators(changes$, [
      [filter, (change: any) => change.type === ExtensionActionTypes.DISPATCH],
      [map, (change: any) => this.unwrapAction(change.payload)],
    ]);

    // Listen for unlifted actions
    const actions$ = applyOperators(changes$, [
      [filter, (change: any) => change.type === ExtensionActionTypes.ACTION],
      [map, (change: any) => this.unwrapAction(change.payload)],
    ]);

    const actionsUntilStop$ = takeUntil.call(actions$, stop$);
    const liftedUntilStop$ = takeUntil.call(liftedActions$, stop$);

    // Only take the action sources between the start/stop events
    this.actions$ = switchMap.call(start$, () => actionsUntilStop$);
    this.liftedActions$ = switchMap.call(start$, () => liftedUntilStop$);
  }

  private unwrapAction(action: Action) {
    return typeof action === 'string' ? eval(`(${action})`) : action;
  }

  private getExtensionConfig(instanceId: string, config: StoreDevtoolsConfig) {
    const extensionOptions: ReduxDevtoolsExtensionConfig = {
      instanceId: instanceId,
      name: config.name,
      features: config.features,
      serialize: config.serialize,
      // The action/state sanitizers are not added to the config
      // because sanitation is done in this class already.
      // It is done before sending it to the devtools extension for consistency:
      // - If we call extensionConnection.send(...),
      //   the extension would call the sanitizers.
      // - If we call devtoolsExtension.send(...) (aka full state update),
      //   the extension would NOT call the sanitizers, so we have to do it ourselves.
    };
    if (config.maxAge !== false /* support === 0 */) {
      extensionOptions.maxAge = config.maxAge;
    }
    return extensionOptions;
  }
}
