export default {
  routes: [
    { method: 'GET', path: '/config-plane/achievements', handler: 'config-plane.achievements', config: { auth: false } },
    { method: 'GET', path: '/config-plane/offers', handler: 'config-plane.offers', config: { auth: false } },
    { method: 'POST', path: '/config-plane/verify-key', handler: 'config-plane.verifyKey', config: { auth: false } },
  ],
}
