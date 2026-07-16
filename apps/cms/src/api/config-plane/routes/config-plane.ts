export default {
  routes: [
    { method: 'GET', path: '/config-plane/achievements', handler: 'config-plane.achievements', config: { auth: false } },
    { method: 'GET', path: '/config-plane/offers', handler: 'config-plane.offers', config: { auth: false } },
    { method: 'GET', path: '/config-plane/rewards', handler: 'config-plane.rewards', config: { auth: false } },
    { method: 'GET', path: '/config-plane/timed-events/all', handler: 'config-plane.timedEventsAll', config: { auth: false } },
    { method: 'GET', path: '/config-plane/timed-events', handler: 'config-plane.timedEvents', config: { auth: false } },
    { method: 'GET', path: '/config-plane/webhook-endpoints', handler: 'config-plane.webhookEndpoints', config: { auth: false } },
    { method: 'GET', path: '/config-plane/projects/:projectId/event-types', handler: 'config-plane.eventTypes', config: { auth: false } },
    { method: 'GET', path: '/config-plane/projects/:projectId/point-rules', handler: 'config-plane.pointRules', config: { auth: false } },
    { method: 'GET', path: '/config-plane/projects/:projectId/export', handler: 'config-plane.exportProject', config: { auth: false } },
    { method: 'POST', path: '/config-plane/projects/:projectId/import', handler: 'config-plane.importProject', config: { auth: false } },
    { method: 'POST', path: '/config-plane/verify-key', handler: 'config-plane.verifyKey', config: { auth: false } },
  ],
}
