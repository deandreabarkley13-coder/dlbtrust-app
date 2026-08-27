// Role-based portal routing shared by the login pages and the portal dashboards.
// Trustees belong in the trustee dashboard; beneficiaries in the trust portal.
(function (global) {
  var ADMIN_KEY = 'dlb-admin-token';
  var USER_KEY = 'dlb-beneficiary-token';
  var TRUSTEE_HOME = '/dashboard';
  var BENEFICIARY_HOME = '/trust-portal/dashboard.html';
  var LOGIN = '/trust-portal/index.html';

  function isTrusteeRole(roles, role) {
    var all = (Array.isArray(roles) ? roles : []).concat([role]);
    return all.some(function (r) { return String(r || '').toLowerCase().indexOf('trustee') !== -1; })
      || ['admin', 'operator'].indexOf(String(role || '').toLowerCase()) !== -1;
  }

  function homeForRoles(roles, role) {
    return isTrusteeRole(roles, role) ? TRUSTEE_HOME : BENEFICIARY_HOME;
  }

  // Resolves the home page for the stored session, or null when there is no
  // usable session (no token, expired token, revoked account).
  function resolveHome() {
    if (localStorage.getItem(ADMIN_KEY)) return Promise.resolve(TRUSTEE_HOME);
    var token = localStorage.getItem(USER_KEY);
    if (!token) return Promise.resolve(null);
    return fetch('/api/dapp/auth/me', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
      .then(function (out) {
        if (!out.res.ok || !out.body || !out.body.success) {
          // Drop a rejected token so the login page starts from a clean session.
          if (out.res.status === 401 || out.res.status === 403) localStorage.removeItem(USER_KEY);
          return null;
        }
        var data = out.body.data || {};
        var user = data.dappUser || data.user || {};
        return homeForRoles(user.roles, user.role || user.active_role);
      })
      .catch(function () { return null; });
  }

  global.PortalRouting = {
    ADMIN_KEY: ADMIN_KEY,
    USER_KEY: USER_KEY,
    TRUSTEE_HOME: TRUSTEE_HOME,
    BENEFICIARY_HOME: BENEFICIARY_HOME,
    LOGIN: LOGIN,
    isTrusteeRole: isTrusteeRole,
    homeForRoles: homeForRoles,
    resolveHome: resolveHome,
  };
})(window);
