export default {
  routes: [
    { method: 'GET', path: '/config-plane/achievements', handler: 'config-plane.achievements', config: { auth: false } },
    { method: 'GET', path: '/config-plane/offers', handler: 'config-plane.offers', config: { auth: false } },
    { method: 'GET', path: '/config-plane/timed-events/all', handler: 'config-plane.timedEventsAll', config: { auth: false } },
    { method: 'GET', path: '/config-plane/timed-events', handler: 'config-plane.timedEvents', config: { auth: false } },
    { method: 'GET', path: '/config-plane/webhook-endpoints', handler: 'config-plane.webhookEndpoints', config: { auth: false } },
    { method: 'GET', path: '/config-plane/projects/:projectId/event-types', handler: 'config-plane.eventTypes', config: { auth: false } },
    { method: 'POST', path: '/config-plane/verify-key', handler: 'config-plane.verifyKey', config: { auth: false } },
  ],
}
