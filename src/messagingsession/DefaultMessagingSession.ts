// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import FullJitterBackoff from '../backoff/FullJitterBackoff';
import CSPMonitor from '../cspmonitor/CSPMonitor';
import Logger from '../logger/Logger';
import Message from '../message/Message';
import MessagingSessionObserver from '../messagingsessionobserver/MessagingSessionObserver';
import DefaultReconnectController from '../reconnectcontroller/DefaultReconnectController';
import ReconnectController from '../reconnectcontroller/ReconnectController';
import AsyncScheduler from '../scheduler/AsyncScheduler';
import DefaultSigV4 from '../sigv4/DefaultSigV4';
import SigV4 from '../sigv4/SigV4';
import DefaultWebSocketAdapter from '../websocketadapter/DefaultWebSocketAdapter';
import WebSocketAdapter from '../websocketadapter/WebSocketAdapter';
import WebSocketReadyState from '../websocketadapter/WebSocketReadyState';
import MessagingSession from './MessagingSession';
import MessagingSessionConfiguration from './MessagingSessionConfiguration';

export default class DefaultMessagingSession implements MessagingSession {
  private observerQueue: Set<MessagingSessionObserver> = new Set<MessagingSessionObserver>();
  private isClosing: boolean;
  private isSessionEstablished: boolean;

  constructor(
    private configuration: MessagingSessionConfiguration,
    private logger: Logger,
    private readonly webSocket?: WebSocketAdapter,
    private readonly reconnectController?: ReconnectController,
    private readonly sigV4?: SigV4
  ) {
    if (!this.webSocket) {
      this.webSocket = new DefaultWebSocketAdapter(this.logger);
    }
    if (!this.reconnectController) {
      this.reconnectController = new DefaultReconnectController(
        configuration.reconnectTimeoutMs,
        new FullJitterBackoff(
          configuration.reconnectFixedWaitMs,
          configuration.reconnectShortBackoffMs,
          configuration.reconnectLongBackoffMs
        )
      );
    }
    if (!this.sigV4) {
      this.sigV4 = new DefaultSigV4(this.configuration.chimeClient, this.configuration.awsClient);
    }

    CSPMonitor.addLogger(this.logger);
    CSPMonitor.register();
  }

  addObserver(observer: MessagingSessionObserver): void {
    this.logger.info('adding messaging observer');
    this.observerQueue.add(observer);
  }

  removeObserver(observer: MessagingSessionObserver): void {
    this.logger.info('removing messaging observer');
    this.observerQueue.delete(observer);
  }

  async start(): Promise<void> {
    if (this.isClosed()) {
      await this.startConnecting(false);
    } else {
      this.logger.info('messaging session already started');
    }
  }

  stop(): void {
    if (!this.isClosed()) {
      this.isClosing = true;
      this.webSocket.close();
      CSPMonitor.removeLogger(this.logger);
    } else {
      this.logger.info('no existing messaging session needs closing');
    }
  }

  forEachObserver(observerFunc: (observer: MessagingSessionObserver) => void): void {
    for (const observer of this.observerQueue) {
      AsyncScheduler.nextTick(() => {
        if (this.observerQueue.has(observer)) {
          observerFunc(observer);
        }
      });
    }
  }

  private setUpEventListeners(): void {
    this.webSocket.addEventListener('open', () => {
      this.openEventHandler();
    });
    this.webSocket.addEventListener('message', (event: MessageEvent) => {
      this.receiveMessageHandler(event.data);
    });
    this.webSocket.addEventListener('close', (event: CloseEvent) => {
      this.closeEventHandler(event);
    });
    this.webSocket.addEventListener('error', () => {
      this.logger.error(`WebSocket error`);
    });
  }

  private async startConnecting(reconnecting: boolean): Promise<void> {
    const signedUrl = await this.prepareWebSocketUrl();
    this.logger.info(`opening connection to ${signedUrl}`);
    if (!reconnecting) {
      this.reconnectController.reset();
    }
    if (this.reconnectController.hasStartedConnectionAttempt()) {
      this.reconnectController.startedConnectionAttempt(false);
    } else {
      this.reconnectController.startedConnectionAttempt(true);
    }
    this.webSocket.create(signedUrl, [], true);
    this.forEachObserver(observer => {
      if (observer.messagingSessionDidStartConnecting) {
        observer.messagingSessionDidStartConnecting(reconnecting);
      }
    });
    this.setUpEventListeners();
  }

  private async prepareWebSocketUrl(): Promise<string> {
    const queryParams = new Map<string, string[]>();
    queryParams.set('userArn', [this.configuration.userArn]);
    queryParams.set('sessionId', [this.configuration.messagingSessionId]);
    return await this.sigV4.signURL(
      'GET',
      'wss',
      'chime',
      this.configuration.endpointUrl,
      '/connect',
      '',
      queryParams
    );
  }

  private isClosed(): boolean {
    return (
      this.webSocket.readyState() === WebSocketReadyState.None ||
      this.webSocket.readyState() === WebSocketReadyState.Closed
    );
  }

  private openEventHandler(): void {
    this.reconnectController.reset();
    this.isSessionEstablished = false;
  }

  private receiveMessageHandler(data: string): void {
    try {
      const jsonData = JSON.parse(data);
      const messageType = jsonData.Headers['x-amz-chime-event-type'];
      const message = new Message(messageType, jsonData.Headers, jsonData.Payload || null);
      if (!this.isSessionEstablished && messageType === 'SESSION_ESTABLISHED') {
        // Backend connects WebSocket and then either
        // (1) Closes with WebSocket error code to reflect failure to authorize or other connection error OR
        // (2) Sends SESSION_ESTABLISHED. SESSION_ESTABLISHED indicates that all messages and events on a channel
        // the app instance user is a member of is guaranteed to be delivered on this WebSocket as long as the WebSocket
        // connection stays opened.
        this.forEachObserver(observer => {
          if (observer.messagingSessionDidStart) {
            observer.messagingSessionDidStart();
          }
        });
        this.isSessionEstablished = true;
      } else if (!this.isSessionEstablished) {
        // SESSION_ESTABLISHED is not guaranteed to be the first message, and in rare conditions a message or event from
        // a channel the member is a member of might arrive prior to SESSION_ESTABLISHED.  Because SESSION_ESTABLISHED indicates
        // it is safe to bootstrap the user application with out any race conditions in losing events we opt to drop messages prior
        // to SESSION_ESTABLISHED being received
        return;
      }
      this.forEachObserver(observer => {
        if (observer.messagingSessionDidReceiveMessage) {
          observer.messagingSessionDidReceiveMessage(message);
        }
      });
    } catch (error) {
      this.logger.error(`Messaging parsing failed: ${error}`);
    }
  }

  private closeEventHandler(event: CloseEvent): void {
    this.logger.info(`WebSocket close: ${event.code} ${event.reason}`);
    this.webSocket.destroy();
    if (
      !this.isClosing &&
      this.canReconnect(event.code) &&
      this.reconnectController.retryWithBackoff(async () => {
        this.startConnecting(true);
      }, null)
    ) {
      return;
    }
    this.isClosing = false;
    if (this.isSessionEstablished) {
      this.forEachObserver(observer => {
        if (observer.messagingSessionDidStop) {
          observer.messagingSessionDidStop(event);
        }
      });
    }
  }

  private canReconnect(closeCode: number): boolean {
    // 4003 is Kicked closing event from the back end
    return (
      closeCode === 1001 ||
      closeCode === 1006 ||
      (closeCode >= 1011 && closeCode <= 1014) ||
      (closeCode > 4000 && closeCode !== 4002 && closeCode !== 4003 && closeCode !== 4401)
    );
  }
}
