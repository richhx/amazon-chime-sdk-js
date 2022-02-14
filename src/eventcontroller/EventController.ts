// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import EventObserver from '../eventobserver/EventObserver';
import EventReporter from '../eventreporter/EventReporter';
import AudioVideoEventAttributes from './AudioVideoEventAttributes';
import DeviceEventAttributes from './DeviceEventAttributes';
import EventName from './EventName';
import MeetingHistoryState from './MeetingHistoryState';

/**
 * [[EventController]] keeps track of a list of event observers and notifies them of SDK events.
 * An event can describe success or failure of SDK components that make use of this controller.
 * Example: The success and failure for a meeting session.
 * By default this will also report metrics to a external ingestion service by using the EventReporter.
 */
export default interface EventController {
  /**
   * Adds an observer for event published to this controller.
   */
  addObserver(observer: EventObserver): void;

  /**
   * Removes an observer for event published to this controller.
   */
  removeObserver(observer: EventObserver): void;

  /**
   * Passes each observer of this controller to a given function.
   */
  forEachObserver(observerFunc: (observer: EventObserver) => void): void;

  /**
   * Notifies observers of an event.
   */
  publishEvent(
    name: EventName,
    attributes?: AudioVideoEventAttributes | DeviceEventAttributes
  ): Promise<void>;

  /**
   * A function that can be called to push a meeting state to the meeting history i.e. push a meeting event to the event
   * history. It will also report to the ingestion service without notifying event observers.
   */
  pushMeetingState?(state: MeetingHistoryState): Promise<void>;

  /**
   * EventReporter that the EventController uses to send events to the ingestion service.
   */
  readonly eventReporter?: EventReporter;
}
