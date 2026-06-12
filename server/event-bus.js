/**
 * Central Event Bus — dlbtrust-app
 * All modules import this and emit/listen for bond:updated events.
 */

'use strict';

const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
