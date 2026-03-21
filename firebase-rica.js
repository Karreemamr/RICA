/* ================================================================
   RICA — Firebase Cloud Integration Layer
   ================================================================
   Replaces all localStorage usage with Firebase Auth + Firestore.
   
   HOW TO USE:
   1. Create a project at console.firebase.google.com
   2. Enable Authentication → Email/Password
   3. Enable Firestore Database → Start in production mode
   4. Add your config below (replace the placeholder values)
   5. Add Firestore security rules (see bottom of this file)
   6. Include this script BEFORE your main RICA HTML logic
   
   WHAT THIS FILE DOES:
   ✓ Replaces doLogin() / doSignUp() with Firebase Auth
   ✓ Replaces the DB module (all tables) with Firestore
   ✓ Each user gets their own isolated data namespace in Firestore
   ✓ Login from any device → same data appears automatically
   ✓ Keeps the exact same DB.getAll / DB.insert / DB.update API
     so no other code needs to change
   ================================================================ */


/* ── 1. YOUR FIREBASE CONFIG ─────────────────────────────────────
   Paste your config from Firebase Console:
   Project Settings → Your apps → Web app → SDK setup → Config
   ────────────────────────────────────────────────────────────── */
const RICA_FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDSZKfdOxbJqqMeGbEdcjDwIgzG7X5KdLE",
  authDomain:        "rica-426b9.firebaseapp.com",
  projectId:         "rica-426b9",
  storageBucket:     "rica-426b9.firebasestorage.app",
  messagingSenderId: "211490839079",
  appId:             "1:211490839079:web:ab3f51aace86496acb8c02"
};

/* ── 2. FIREBASE SDK LOADER ──────────────────────────────────────
   Loads Firebase v9 (compat mode = same API as v8, no bundler needed)
   ────────────────────────────────────────────────────────────── */
(function loadFirebaseSDK(callback) {
  var scripts = [
    "https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js",
    "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js"
  ];
  var loaded = 0;
  scripts.forEach(function(src) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function() { if (++loaded === scripts.length) callback(); };
    s.onerror = function() { console.error('Failed to load Firebase SDK:', src); };
    document.head.appendChild(s);
  });
})(function onFirebaseLoaded() {

  /* ── 3. INITIALIZE FIREBASE ──────────────────────────────────── */
  if (!firebase.apps.length) firebase.initializeApp(RICA_FIREBASE_CONFIG);

  var auth = firebase.auth();
  var db   = firebase.firestore();

  /* Offline persistence — data works even with bad connection */
  db.enablePersistence({ synchronizeTabs: true })
    .catch(function(e) {
      if (e.code === 'failed-precondition') {
        console.warn('RICA: Multi-tab offline mode not available.');
      }
    });


  /* ================================================================
     4. AUTH HELPERS
     ================================================================ */

  /* Returns the current Firebase user UID (or null) */
  function getCurrentUID() {
    return auth.currentUser ? auth.currentUser.uid : null;
  }

  /* Returns Firestore root for the current user: /users/{uid}/ */
  function userRoot() {
    var uid = getCurrentUID();
    if (!uid) throw new Error('RICA: No user logged in — cannot access Firestore.');
    return db.collection('users').doc(uid);
  }

  /* Shortcut: /users/{uid}/data/{table} */
  function tableRef(table) {
    return userRoot().collection('data').doc(table);
  }


  /* ================================================================
     5. CLOUD DB MODULE  (same API as the localStorage DB module)
        DB.getAll / DB.insert / DB.update / DB.delete / DB.saveAll
     ================================================================ */

  /* In-memory cache so reads don't hammer Firestore on every render */
  var _cloudCache = {};

  var CloudDB = {

    /* ── getAll ── returns array, resolves from cache or Firestore */
    getAll: function(table) {
      /* SYNC path — return cache if available */
      if (_cloudCache[table] !== undefined) return _cloudCache[table];
      /* Return empty array synchronously; background fetch will update */
      CloudDB._fetch(table);
      return [];
    },

    /* ── Background fetch — populates cache and re-renders ── */
    _fetch: async function(table) {
      try {
        var snap = await tableRef(table).get();
        var records = snap.exists ? (snap.data().records || []) : [];
        _cloudCache[table] = records;
        /* Notify the app to re-render if a hook is registered */
        if (typeof window._ricaOnCloudSync === 'function') {
          window._ricaOnCloudSync(table, records);
        }
      } catch(e) {
        console.error('RICA CloudDB fetch error:', table, e);
        _cloudCache[table] = _cloudCache[table] || [];
      }
    },

    /* ── saveAll — write entire table array to Firestore ── */
    saveAll: async function(table, records) {
      _cloudCache[table] = records;  /* update cache immediately */
      try {
        await tableRef(table).set({ records: records, _updated: new Date().toISOString() });
      } catch(e) {
        console.error('RICA CloudDB saveAll error:', table, e);
      }
    },

    /* ── getById ── */
    getById: function(table, id) {
      return (CloudDB.getAll(table) || []).find(function(r){ return r.id === Number(id); }) || null;
    },

    /* ── nextId ── */
    nextId: function(table) {
      var recs = CloudDB.getAll(table);
      if (!recs || recs.length === 0) return 1;
      return Math.max.apply(Math, recs.map(function(r){ return r.id || 0; })) + 1;
    },

    /* ── insert ── */
    insert: function(table, data) {
      var records = (CloudDB.getAll(table) || []).slice();
      var id = records.length === 0 ? 1 : Math.max.apply(Math, records.map(function(r){ return r.id || 0; })) + 1;
      data.id = id;
      data._created = new Date().toISOString();
      records.push(data);
      CloudDB.saveAll(table, records);
      return id;
    },

    /* ── update ── */
    update: function(table, id, data) {
      var records = (CloudDB.getAll(table) || []).slice();
      var idx = records.findIndex(function(r){ return r.id === Number(id); });
      if (idx === -1) return false;
      records[idx] = Object.assign({}, records[idx], data, { _updated: new Date().toISOString() });
      CloudDB.saveAll(table, records);
      return true;
    },

    /* ── delete ── */
    delete: function(table, id) {
      var records = CloudDB.getAll(table) || [];
      var filtered = records.filter(function(r){ return r.id !== Number(id); });
      if (filtered.length === records.length) return false;
      CloudDB.saveAll(table, filtered);
      return true;
    },

    /* ── count ── */
    count: function(table) {
      return (CloudDB.getAll(table) || []).length;
    },

    /* ── invalidateCache — force re-fetch all tables ── */
    invalidateCache: function() {
      _cloudCache = {};
    },

    /* ── preload — fetch all tables in parallel on login ── */
    preloadAll: async function() {
      var TABLES = ['orders','order_items','inventory','finance','kpis','pricing',
                    'products','customers','shipping','returns','ledger',
                    'promotions','suppliers','taxes','discounts'];
      await Promise.all(TABLES.map(function(t){ return CloudDB._fetch(t); }));
    },

    /* ── getKeyPrefix — kept for backward compat ── */
    getKeyPrefix: function() {
      return 'cloud_' + (getCurrentUID() || 'anon') + '_';
    }
  };

  /* Alias: CloudDB.del = CloudDB.delete */
  CloudDB.del = CloudDB.delete;


  /* ================================================================
     6. USER PROFILE  (stores name, email, phone, etc. in Firestore)
     ================================================================ */

  async function saveUserProfile(profileData) {
    var uid = getCurrentUID();
    if (!uid) return;
    await db.collection('users').doc(uid).set(
      Object.assign({}, profileData, { _updated: new Date().toISOString() }),
      { merge: true }
    );
  }

  async function getUserProfile() {
    var uid = getCurrentUID();
    if (!uid) return null;
    var snap = await db.collection('users').doc(uid).get();
    return snap.exists ? snap.data() : null;
  }


  /* ================================================================
     7. LOGS  (activity log — stored in Firestore subcollection)
     ================================================================ */

  var _logsCache = null;

  async function cloudGetLogs() {
    if (_logsCache !== null) return _logsCache;
    try {
      var snap = await userRoot().collection('logs').doc('activity').get();
      _logsCache = snap.exists ? (snap.data().logs || []) : [];
    } catch(e) { _logsCache = []; }
    return _logsCache;
  }

  async function cloudSaveLogs(logs) {
    _logsCache = logs;
    try {
      await userRoot().collection('logs').doc('activity').set({
        logs: logs.slice(-500),   /* keep last 500 log entries */
        _updated: new Date().toISOString()
      });
    } catch(e) { console.error('RICA: log save error', e); }
  }

  async function cloudAddLog(action, details) {
    var logs = await cloudGetLogs();
    logs.push({
      ts:      new Date().toISOString(),
      action:  action || '',
      details: details || ''
    });
    await cloudSaveLogs(logs);
  }

  function cloudClearLogs() {
    _logsCache = [];
    cloudSaveLogs([]);
  }


  /* ================================================================
     8. OVERRIDE doLogin() — replaces the old localStorage version
     ================================================================ */

  window.doLogin = async function() {
    var emailEl    = document.getElementById('login-username');   /* username field accepts email */
    var passwordEl = document.getElementById('login-password');
    var errEl      = document.getElementById('login-error');
    var btn        = document.getElementById('login-btn');

    if (!emailEl || !passwordEl || !errEl || !btn) return;

    var emailInput = emailEl.value.trim();
    var password   = passwordEl.value;

    errEl.classList.remove('show');
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = 'Signing in…';

    try {
      /* Firebase Auth: sign in with email + password */
      var cred = await auth.signInWithEmailAndPassword(emailInput, password);
      var user = cred.user;

      /* Load user profile from Firestore */
      var profile = await getUserProfile();

      /* Update sidebar with display name */
      var displayName = profile
        ? ((profile.firstname || '') + ' ' + (profile.lastname || '')).trim() || profile.username || user.email
        : user.email;

      var sidebarName = document.getElementById('brand-name-sidebar');
      var loginName   = document.getElementById('brand-name-login');
      if (sidebarName) sidebarName.textContent = displayName;
      if (loginName)   loginName.textContent   = 'RICA';

      /* Pre-load all Firestore data into cache */
      await CloudDB.preloadAll();

      /* Seed database for brand-new users */
      var alreadySeeded = await userRoot().get()
        .then(function(s){ return s.exists && s.data()._seeded; })
        .catch(function(){ return false; });

      if (!alreadySeeded && typeof seedDatabase === 'function') {
        seedDatabase();
        await userRoot().set({ _seeded: true }, { merge: true });
      }

      /* Log the login event */
      cloudAddLog('LOGIN', 'User signed in from ' + (navigator.userAgent || ''));

      /* Show the app */
      sessionStorage.setItem('rica_session', '1');
      _appJustUnlocked = true;
      setTimeout(function(){ _appJustUnlocked = false; }, 800);

      var overlay = document.getElementById('login-overlay');
      if (overlay) {
        overlay.style.transition = 'opacity 0.4s ease';
        overlay.style.opacity = '0';
        setTimeout(function() {
          overlay.style.display = 'none';
          var appEl = document.getElementById('app');
          if (appEl) appEl.style.visibility = 'visible';
        }, 420);
      }

    } catch(e) {
      var msg = 'Incorrect email or password.';
      if (e.code === 'auth/user-not-found')    msg = 'No account found with this email.';
      if (e.code === 'auth/wrong-password')     msg = 'Incorrect password. Please try again.';
      if (e.code === 'auth/invalid-email')      msg = 'Please enter a valid email address.';
      if (e.code === 'auth/too-many-requests')  msg = 'Too many attempts. Please wait and try again.';
      if (e.code === 'auth/user-disabled')      msg = 'This account has been disabled.';
      if (e.code === 'auth/network-request-failed') msg = 'Network error. Check your connection.';

      errEl.textContent = msg;
      errEl.style.display = 'block';
      errEl.classList.add('show');
      passwordEl.value = '';

    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.innerHTML = 'Sign In &nbsp;&mdash;&nbsp; &#x062a;&#x0633;&#x062c;&#x064a;&#x0644; &#x0627;&#x0644;&#x062f;&#x062e;&#x0648;&#x0644;';
    }
  };


  /* ================================================================
     9. OVERRIDE doSignUp() — replaces the old localStorage version
     ================================================================ */

  window.doSignUp = async function() {
    var username  = (document.getElementById('signup-username')  ? document.getElementById('signup-username').value.trim() : '');
    var password  = (document.getElementById('signup-password')  ? document.getElementById('signup-password').value : '');
    var confirm   = (document.getElementById('signup-confirm')   ? document.getElementById('signup-confirm').value : '');
    var email     = (document.getElementById('signup-email')     ? document.getElementById('signup-email').value.trim() : '');
    var phone     = (document.getElementById('signup-phone')     ? document.getElementById('signup-phone').value.trim() : '');
    var firstname = (document.getElementById('signup-firstname') ? document.getElementById('signup-firstname').value.trim() : '');
    var lastname  = (document.getElementById('signup-lastname')  ? document.getElementById('signup-lastname').value.trim() : '');
    var sqKey     = (document.getElementById('signup-sq-select') ? document.getElementById('signup-sq-select').value : '');
    var sqAnswer  = (document.getElementById('signup-sq-answer') ? document.getElementById('signup-sq-answer').value.trim().toLowerCase() : '');
    var errEl     = document.getElementById('signup-error');
    var btn       = document.querySelector('[onclick="doSignUp()"]');

    function showErr(msg) {
      if (!errEl) { alert(msg); return; }
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }

    if (errEl) errEl.style.display = 'none';

    /* ── Validation ── */
    var termsBox = document.getElementById('signup-terms');
    if (termsBox && !termsBox.checked) { showErr('You must agree to the terms & conditions.'); return; }
    if (!email)    { showErr('Email address is required for Firebase login.'); return; }
    if (!password) { showErr('Password is required.'); return; }
    if (password.length < 6) { showErr('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { showErr('Passwords do not match.'); return; }
    if (!sqKey)    { showErr('Please choose a security question.'); return; }
    if (!sqAnswer) { showErr('Please enter your security question answer.'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Creating account…'; }

    try {
      /* Create Firebase Auth user */
      var cred = await auth.createUserWithEmailAndPassword(email, password);
      var user = cred.user;

      /* Update Firebase Auth display name */
      await user.updateProfile({
        displayName: ((firstname + ' ' + lastname).trim()) || username || email
      });

      /* Save full profile to Firestore */
      await db.collection('users').doc(user.uid).set({
        uid:       user.uid,
        username:  username || email.split('@')[0],
        firstname: firstname,
        lastname:  lastname,
        email:     email,
        phone:     phone,
        sq_key:    sqKey,
        sq_answer: sqAnswer,
        created:   new Date().toISOString(),
        _seeded:   false
      });

      /* Seed the database with default data */
      if (typeof seedDatabase === 'function') seedDatabase();
      await db.collection('users').doc(user.uid).set({ _seeded: true }, { merge: true });

      /* Log the registration */
      cloudAddLog('SIGNUP', 'New account created: ' + email);

      /* Sign out — redirect to login screen to confirm email/pw */
      await auth.signOut();

      /* Show success message on login screen */
      if (typeof hideSignUp === 'function') hideSignUp();

      var successBanner = document.getElementById('login-signup-success');
      if (!successBanner) {
        successBanner = document.createElement('div');
        successBanner.id = 'login-signup-success';
        successBanner.style.cssText = 'background:#d4edda;color:#155724;border:1px solid #c3e6cb;border-radius:8px;padding:10px 14px;margin:10px 0;font-size:13px;text-align:center;';
        var loginCard = document.querySelector('.login-card');
        if (loginCard) loginCard.prepend(successBanner);
      }
      successBanner.textContent = '✓ Account created! Please sign in with your email and password.';
      successBanner.style.display = 'block';

    } catch(e) {
      var msg = 'Registration failed. Please try again.';
      if (e.code === 'auth/email-already-in-use') msg = 'This email is already registered. Please sign in.';
      if (e.code === 'auth/invalid-email')        msg = 'Please enter a valid email address.';
      if (e.code === 'auth/weak-password')        msg = 'Password is too weak. Use at least 6 characters.';
      if (e.code === 'auth/network-request-failed') msg = 'Network error. Check your connection.';
      showErr(msg);

    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
    }
  };


  /* ================================================================
     10. LOGOUT
     ================================================================ */

  window.doLogout = async function() {
    cloudAddLog('LOGOUT', 'User signed out');
    await auth.signOut();
    CloudDB.invalidateCache();
    sessionStorage.removeItem('rica_session');
    /* Reload page to show login screen */
    window.location.reload();
  };

  /* Hook into the existing logout button (if present) */
  document.addEventListener('DOMContentLoaded', function() {
    var logoutBtns = document.querySelectorAll('[onclick*="logout"], [onclick*="Logout"], [onclick*="signOut"]');
    logoutBtns.forEach(function(btn) {
      btn.onclick = function() { window.doLogout(); };
    });
  });


  /* ================================================================
     11. AUTH STATE OBSERVER
         Runs on every page load — shows login or app automatically
     ================================================================ */

  auth.onAuthStateChanged(async function(user) {
    var overlay = document.getElementById('login-overlay');
    var appEl   = document.getElementById('app');

    if (user) {
      /* ── User IS logged in ── */
      /* Pre-load all data from Firestore */
      await CloudDB.preloadAll();

      var profile = await getUserProfile();
      var displayName = profile
        ? ((profile.firstname || '') + ' ' + (profile.lastname || '')).trim() || profile.username || user.email
        : user.email;

      /* Update sidebar display name */
      var sidebarName = document.getElementById('brand-name-sidebar');
      if (sidebarName) sidebarName.textContent = displayName;

      /* Update account display */
      var acctDisplay = document.getElementById('account-username-display');
      if (acctDisplay) acctDisplay.textContent = profile && profile.username ? profile.username : user.email;

      /* Hide login overlay, show app */
      sessionStorage.setItem('rica_session', '1');
      if (overlay) { overlay.style.display = 'none'; overlay.style.opacity = '0'; }
      if (appEl)   { appEl.style.visibility = 'visible'; }

      /* Override the email label in login form so user knows to use email */
      var loginUsernameLabel = document.querySelector('label[for="login-username"], .login-label');
      if (loginUsernameLabel && loginUsernameLabel.textContent.toUpperCase() === 'USERNAME') {
        loginUsernameLabel.textContent = 'EMAIL ADDRESS';
      }

    } else {
      /* ── User is NOT logged in — show login screen ── */
      sessionStorage.removeItem('rica_session');
      if (overlay) {
        overlay.style.display = 'flex';
        setTimeout(function(){
          overlay.style.transition = 'opacity 0.3s ease';
          overlay.style.opacity = '1';
        }, 50);
      }
      if (appEl) appEl.style.visibility = 'hidden';
    }
  });


  /* ================================================================
     12. OVERRIDE THE DB MODULE  (injects CloudDB in place of localStorage DB)
     ================================================================ */

  /* Wait for the page DB const to be defined, then override */
  function injectCloudDB() {
    /* Override every method on the existing DB object in-place */
    if (typeof window.DB !== 'undefined' || typeof DB !== 'undefined') {
      var target = typeof window.DB !== 'undefined' ? window.DB : DB;
      Object.keys(CloudDB).forEach(function(k) {
        target[k] = CloudDB[k];
      });
      target.del = CloudDB.delete;
      console.info('RICA: CloudDB injected — all reads/writes go to Firestore.');
    } else {
      setTimeout(injectCloudDB, 100);   /* retry until DB is defined */
    }
  }
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(injectCloudDB, 200);
  });

  /* Also override immediately if DB already exists */
  if (typeof DB !== 'undefined') injectCloudDB();


  /* ================================================================
     13. OVERRIDE LOGS MODULE
     ================================================================ */

  /* Replace the existing LOGS_* functions if they exist */
  window._cloudLogs = {
    get:   cloudGetLogs,
    save:  cloudSaveLogs,
    add:   cloudAddLog,
    clear: cloudClearLogs
  };

  /* Patch the log display function */
  window.viewLogs = async function() {
    var logs = await cloudGetLogs();
    var modal = document.getElementById('logs-viewer-modal');
    var tbody = document.getElementById('logs-table');
    if (!modal || !tbody) return;

    var rows = logs.slice().reverse().map(function(l) {
      var d = new Date(l.ts);
      var dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
      return '<tr><td>' + dateStr + '</td><td>' + (l.action || '') + '</td><td>' + (l.details || '') + '</td></tr>';
    }).join('');

    tbody.innerHTML = rows || '<tr><td colspan="3" style="text-align:center;color:#888">No logs yet.</td></tr>';
    modal.style.display = 'flex';
  };


  /* ================================================================
     14. EXPORT PUBLIC API
     ================================================================ */

  window.RicaFirebase = {
    auth:           auth,
    db:             db,
    CloudDB:        CloudDB,
    getCurrentUID:  getCurrentUID,
    userRoot:       userRoot,
    saveProfile:    saveUserProfile,
    getProfile:     getUserProfile,
    addLog:         cloudAddLog,
    getLogs:        cloudGetLogs,
    clearLogs:      cloudClearLogs,
    logout:         window.doLogout
  };

  console.info('RICA Firebase integration loaded ✓');

}); /* end onFirebaseLoaded */


/* ================================================================
   15. FIRESTORE SECURITY RULES
   ================================================================
   Paste these rules in Firebase Console →
   Firestore Database → Rules tab → Publish

   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {

       // Each user can only read/write their own data
       match /users/{userId} {
         allow read, write: if request.auth != null
                            && request.auth.uid == userId;

         match /data/{table} {
           allow read, write: if request.auth != null
                              && request.auth.uid == userId;
         }
         match /logs/{doc} {
           allow read, write: if request.auth != null
                              && request.auth.uid == userId;
         }
       }
     }
   }
   ================================================================ */
