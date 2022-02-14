// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import EventAttributes from '../eventcontroller/EventAttributes';
import EventName from '../eventcontroller/EventName';

export default interface EventObserver {
  /**
   * Called when specific events occur during the SDK session and includes attributes of the event. Example: This can be used to
   * create analytics around meeting metrics.
   */
  eventDidReceive(name: EventName, attributes: EventAttributes): void;
}
