/**
 * ============================================================
 * SCRIPT.JS — SVS Manager Dashboard v2
 * ============================================================
 * Port dari dashboard v1 (svs-dashboard, Apps Script) — Overview,
 * Project Explorer, Performa Sales, Log Aktivitas SEMUA sudah utuh
 * di versi lama, jadi di-port apa adanya, hanya lapisan datanya yang
 * diganti: MGR_CONFIG token -> Firebase Auth (Bearer token), dan
 * nama field disesuaikan ke snake_case (mengikuti skema Firestore).
 *
 * BARU di v2: gerbang login, business switcher (Aluve/GBP, khusus
 * super_admin), dan tab Admin Console (Admin Lookup, Kelola Akun
 * User, Pengaturan Estimator).
 * ============================================================ */

/* ============================================================
   1. STATE
   ============================================================ */
const State = {
  idToken: null,
  user: null, // { uid, name, role, business_id, sales_code, status, email }
  businessId: 'aluve', // dipakai super_admin untuk switcher; manager terkunci ke business_id akun sendiri

  currentTab: 'overview',
  filters: { date_from: '', date_to: '', sales_uid: '', pipeline_stage: '', lead_source: '', product_type: '' },
  trendGranularity: 'daily',
  overviewData: null,
  charts: {},
  logOffset: 0,
  logLimit: 25,
  logTotalCount: 0,
  salesNameByUid: {},
  lookupStages: [],
  lookupData: {},
  currentLookupCategory: 'pipeline_stage'
};

const LOOKUP_CATEGORIES = [
  { key: 'pipeline_stage', label: 'Pipeline Stage' },
  { key: 'activity_type', label: 'Jenis Aktivitas' },
  { key: 'activity_temperature', label: 'Suhu Lead' },
  { key: 'project_category', label: 'Kategori Project' },
  { key: 'construction_stage', label: 'Tahap Konstruksi' },
  { key: 'product_type', label: 'Jenis Produk' },
  { key: 'lead_source', label: 'Sumber Leads' },
  { key: 'lost_reason', label: 'Alasan Lost' },
  { key: 'contact_role', label: 'Role Kontak' }
];

// Nilai default yang SAMA PERSIS dipakai Sales App sebagai fallback saat
// Firestore belum ada datanya (LookupCache.DEFAULTS di script.js Sales App).
// Dipakai tombol "Isi dari Default" di Admin Lookup — supaya Firestore-nya
// benar-benar terisi, bukan cuma tampil karena fallback client-side.
const LOOKUP_DEFAULTS = {
  activity_type: ['Kunjungan Pertama', 'Follow Up', 'Presentasi Produk', 'Negosiasi', 'Survey Lokasi', 'Lainnya'],
  pipeline_stage: ['New Visit', 'Perlu Estimasi Harga', 'Penawaran Siap', 'Won', 'Lost'],
  activity_temperature: ['Cold', 'Warm', 'Hot'],
  project_category: ['Residensial', 'Komersial', 'Industrial', 'Villa'],
  construction_stage: ['Perencanaan', 'Pembangunan', 'Finishing', 'Selesai'],
  product_type: ['Jendela Aluminium', 'Pintu Aluminium', 'Curtain Wall', 'Facade', 'Partisi Kaca'],
  lead_source: ['Canvassing', 'Referral', 'Website', 'Pameran'],
  lost_reason: ['Harga Kalah Bersaing', 'Pilih Vendor Lain', 'Project Dibatalkan', 'Tidak Ada Kabar'],
  contact_role: ['Pemilik', 'Arsitek', 'Kontraktor', 'Interior Designer', 'Lainnya']
};

/* ============================================================
   2. API — semua request pakai Bearer token Firebase Auth
   ============================================================ */
const Api = {
  async rawCall(action, payload) {
    const res = await fetch(WORKER_BASE_URL + '/' + action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + State.idToken
      },
      body: JSON.stringify(payload || {})
    });
    return res.json();
  },
  async call(action, payload) {
    try {
      return await this.rawCall(action, payload);
    } catch (err) {
      return { success: false, message: 'Gagal terhubung ke server. Cek koneksi internet.' };
    }
  },
  /** Sisipkan business_id ke payload — dipakai endpoint manager/admin */
  withBusiness(payload) {
    return Object.assign({ business_id: State.businessId }, payload || {});
  }
};

/* ============================================================
   3. LOADING INDICATOR
   ============================================================ */
const LoadingIndicator = {
  intervals: {},
  start(elId) {
    const el = document.querySelector('#' + elId + ' .loading-container-text');
    if (!el) return;
    const base = el.dataset.baseText || el.textContent;
    let dots = 0;
    this.stop(elId);
    this.intervals[elId] = setInterval(() => {
      dots = (dots + 1) % 4;
      el.textContent = base + '.'.repeat(dots);
    }, 400);
  },
  stop(elId) {
    if (this.intervals[elId]) { clearInterval(this.intervals[elId]); delete this.intervals[elId]; }
  }
};

/* ============================================================
   4. SNACKBAR
   ============================================================ */
const Snackbar = {
  el: null, timer: null,
  init() { this.el = document.getElementById('snackbar'); },
  show(message, type) {
    if (!this.el) return;
    this.el.textContent = message;
    this.el.className = 'snackbar show snackbar-' + (type || 'info');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.el.classList.remove('show'), 3000);
  }
};

/* ============================================================
   5. THEME TOGGLE
   ============================================================ */
const ThemeToggle = {
  STORAGE_KEY: 'mgr_theme',
  init() {
    const saved = localStorage.getItem(this.STORAGE_KEY);
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    this.updateIcon();
    document.getElementById('btn-theme-toggle').addEventListener('click', () => this.toggle());
  },
  toggle() {
    const next = this.isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(this.STORAGE_KEY, next);
    this.updateIcon();
    if (State.overviewData) OverviewPage.renderAllCharts();
  },
  isDark() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr) return attr === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  },
  updateIcon() {
    document.getElementById('btn-theme-toggle').classList.toggle('is-dark', this.isDark());
  }
};

/* ============================================================
   6. UTILS
   ============================================================ */
const Utils = {
  formatCurrency(value) { return 'Rp ' + Number(value || 0).toLocaleString('id-ID'); },
  formatShortDate(dateValue) {
    if (!dateValue) return '-';
    const d = new Date(dateValue);
    if (isNaN(d.getTime())) return '-';
    const bulan = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    return d.getDate() + ' ' + bulan[d.getMonth()];
  },
  chartPalette: ['#1E3A8A', '#16A34A', '#F59E0B', '#DC2626', '#0EA5E9', '#8B5CF6', '#EC4899', '#64748B'],
  chartTextColor() { return ThemeToggle.isDark() ? '#9CA3AF' : '#6B7280'; },
  chartGridColor() { return ThemeToggle.isDark() ? '#2E3036' : '#E5E7EB'; }
};

/* ============================================================
   7. OVERVIEW CACHE (localStorage, hanya untuk tampilan default tanpa filter)
   ============================================================ */
const OverviewCache = {
  key() { return 'mgr_overview_cache_v2_' + State.businessId; },
  save(overviewData, trendData) {
    try { localStorage.setItem(this.key(), JSON.stringify({ overviewData, trendData, savedAt: Date.now() })); } catch (e) { /* abaikan */ }
  },
  get() {
    try { const raw = localStorage.getItem(this.key()); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  },
  formatSavedAt(timestamp) {
    return new Date(timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }
};

/* ============================================================
   8. LOGIN
   ============================================================ */
const Login = {
  REMEMBER_KEY: 'mgr_remembered_email',
  REFRESH_KEY: 'mgr_refresh_token',

  init() {
    document.getElementById('btn-login').addEventListener('click', () => this.submit());
    document.getElementById('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.submit(); });
    document.getElementById('btn-toggle-pw').addEventListener('click', () => {
      const input = document.getElementById('login-password');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('btn-logout').addEventListener('click', () => this.logout());
    document.getElementById('login-forgot').addEventListener('click', (e) => {
      e.preventDefault();
      alert('Lupa password? Hubungi Super Admin untuk direset — password sementara baru akan dibagikan manual.');
    });

    // Isi ulang email tersimpan (kalau sebelumnya centang "Remember me")
    const remembered = localStorage.getItem(this.REMEMBER_KEY);
    if (remembered) {
      document.getElementById('login-email').value = remembered;
      document.getElementById('login-remember').checked = true;
    }

    // Kalau ada sesi tersimpan (refresh token), coba login otomatis diam-diam
    // sebelum menampilkan form login — supaya "Remember me" benar-benar
    // mempertahankan sesi, bukan cuma mengisi ulang email.
    const hasSession = localStorage.getItem(this.REFRESH_KEY);
    if (hasSession) {
      document.getElementById('view-login').hidden = true;
      this.trySilentLogin().then((ok) => {
        if (!ok) document.getElementById('view-login').hidden = false;
      });
    }
  },

  /** Tukar refresh token tersimpan dengan idToken baru — dipakai untuk login otomatis */
  async trySilentLogin() {
    const refreshToken = localStorage.getItem(this.REFRESH_KEY);
    if (!refreshToken) return false;
    try {
      const res = await fetch('https://securetoken.googleapis.com/v1/token?key=' + FIREBASE_API_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
      });
      const json = await res.json();
      if (!res.ok) throw new Error('Sesi tersimpan sudah tidak berlaku');

      State.idToken = json.id_token;
      // Google me-rotasi refresh token tiap dipakai — simpan yang baru
      localStorage.setItem(this.REFRESH_KEY, json.refresh_token);

      const profileResult = await Api.rawCall('readMyProfile', {});
      if (!profileResult.success || !['manager', 'super_admin'].includes(profileResult.data.role)) {
        throw new Error('Akun tidak valid untuk Manager Dashboard');
      }

      State.user = profileResult.data;
      State.businessId = State.user.business_id;

      document.getElementById('view-login').hidden = true;
      document.getElementById('app').hidden = false;
      initApp();
      return true;
    } catch (err) {
      localStorage.removeItem(this.REFRESH_KEY);
      return false;
    }
  },

  async submit() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('btn-login');
    errorEl.textContent = '';

    if (!email || !password) { errorEl.textContent = 'Isi email dan password.'; return; }

    btn.disabled = true;
    btn.textContent = 'Masuk...';

    try {
      const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FIREBASE_API_KEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ? json.error.message : 'Login gagal');

      State.idToken = json.idToken;

      const profileResult = await Api.rawCall('readMyProfile', {});
      if (!profileResult.success) throw new Error(profileResult.message || 'Gagal memuat profil');

      if (!['manager', 'super_admin'].includes(profileResult.data.role)) {
        throw new Error('Akun ini tidak punya akses ke Manager Dashboard.');
      }

      State.user = profileResult.data;
      State.businessId = State.user.business_id;

      const rememberChecked = document.getElementById('login-remember').checked;
      if (rememberChecked) {
        localStorage.setItem(this.REMEMBER_KEY, email);
        localStorage.setItem(this.REFRESH_KEY, json.refreshToken);
      } else {
        localStorage.removeItem(this.REMEMBER_KEY);
        localStorage.removeItem(this.REFRESH_KEY);
      }

      document.getElementById('view-login').hidden = true;
      document.getElementById('app').hidden = false;
      initApp();
    } catch (err) {
      let msg = err.message || 'Login gagal';
      if (msg.includes('INVALID') || msg.includes('PASSWORD') || msg.includes('EMAIL_NOT_FOUND')) {
        msg = 'Email atau password salah.';
      }
      errorEl.textContent = msg;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Log in';
    }
  },

  logout() {
    State.idToken = null;
    State.user = null;
    localStorage.removeItem(this.REFRESH_KEY);
    document.getElementById('app').hidden = true;
    document.getElementById('view-login').hidden = false;
    document.getElementById('login-password').value = '';
  }
};

/* ============================================================
   9. BUSINESS SWITCHER (khusus super_admin)
   ============================================================ */
const BusinessSwitcher = {
  init() {
    const wrap = document.getElementById('business-switcher');
    this.updateHeaderLogo();

    // Boleh switch kalau super_admin (bebas pilih bisnis manapun) ATAU
    // akun biasa yang memang diberi akses >1 bisnis oleh super_admin
    // (lewat Kelola Akun User).
    const myBusinessIds = Array.isArray(State.user.business_ids) ? State.user.business_ids : [State.user.business_id];
    const isSuperAdmin = State.user.role === 'super_admin';
    if (!isSuperAdmin && myBusinessIds.length <= 1) { wrap.hidden = true; return; }

    wrap.hidden = false;
    wrap.querySelectorAll('button').forEach((btn) => {
      const allowed = isSuperAdmin || myBusinessIds.includes(btn.dataset.business);
      btn.hidden = !allowed;
      btn.classList.toggle('active', btn.dataset.business === State.businessId);
      btn.addEventListener('click', () => this.switchTo(btn.dataset.business));
    });
  },
  updateHeaderLogo() {
    const logoEl = document.getElementById('header-logo');
    logoEl.src = State.businessId === 'gbp' ? './assets/icons/logo-gbp.png' : './assets/icons/logo-aluve.png';
  },
  switchTo(businessId) {
    if (businessId === State.businessId) return;
    State.businessId = businessId;
    document.querySelectorAll('#business-switcher button').forEach((b) => b.classList.toggle('active', b.dataset.business === businessId));
    this.updateHeaderLogo();

    // Reset state yang bergantung bisnis, lalu muat ulang tab aktif + filter
    State.overviewData = null;
    State.explorerLoaded = false;
    State.performanceLoaded = false;
    State.logLoaded = false;
    State.logOffset = 0;

    FilterBar.reloadOptions().then(() => {
      TabNav.reload(State.currentTab);
    });

    if (State.currentTab === 'admin') AdminLookup.load();
  }
};

/* ============================================================
   10. TAB NAVIGATION
   ============================================================ */
const TabNav = {
  init() {
    document.querySelectorAll('.mgr-tab').forEach((tab) => {
      tab.addEventListener('click', () => this.goTo(tab.dataset.tab));
    });
  },
  goTo(tabName) {
    State.currentTab = tabName;
    document.querySelectorAll('.mgr-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabName));
    document.querySelectorAll('.mgr-tab-content').forEach((c) => c.classList.remove('active'));
    document.getElementById('tab-' + tabName).classList.add('active');
    document.getElementById('global-filter-bar').hidden = (tabName === 'admin');

    this.reload(tabName);
  },
  reload(tabName) {
    if (tabName === 'overview' && !State.overviewData) OverviewPage.load();
    if (tabName === 'explorer' && !State.explorerLoaded) ExplorerPage.load();
    if (tabName === 'performance' && !State.performanceLoaded) PerformancePage.load();
    if (tabName === 'log' && !State.logLoaded) LogPage.load();
    if (tabName === 'admin' && !State.adminInitialized) { AdminConsole.init(); State.adminInitialized = true; }
  }
};

/* ============================================================
   11. FILTER BAR
   ============================================================ */
const FilterBar = {
  async init() {
    await this.reloadOptions();

    document.getElementById('btn-apply-filter').addEventListener('click', () => {
      State.filters.date_from = document.getElementById('filter-date-from').value;
      State.filters.date_to = document.getElementById('filter-date-to').value;
      State.filters.sales_uid = document.getElementById('filter-sales').value;
      State.filters.pipeline_stage = document.getElementById('filter-stage').value;
      State.filters.lead_source = document.getElementById('filter-lead-source').value;
      State.filters.product_type = document.getElementById('filter-product').value;
      OverviewPage.load();
    });

    document.getElementById('btn-reset-filter').addEventListener('click', () => {
      ['filter-date-from', 'filter-date-to', 'filter-sales', 'filter-stage', 'filter-lead-source', 'filter-product'].forEach((id) => {
        document.getElementById(id).value = '';
      });
      State.filters = { date_from: '', date_to: '', sales_uid: '', pipeline_stage: '', lead_source: '', product_type: '' };
      OverviewPage.load();
    });
  },

  async reloadOptions() {
    ['filter-sales', 'filter-stage', 'filter-lead-source', 'filter-product', 'explorer-lead-source'].forEach((id) => {
      const el = document.getElementById(id);
      while (el.options.length > 1) el.remove(1);
    });
    await Promise.all([this.loadSalesOptions(), this.loadStageOptions()]);
  },

  async loadSalesOptions() {
    const result = await Api.call('readSalesList', Api.withBusiness({}));
    const select = document.getElementById('filter-sales');
    State.salesNameByUid = {};
    if (result.success && result.data) {
      result.data.forEach((s) => {
        State.salesNameByUid[s.sales_uid] = s.sales_name;
        const opt = document.createElement('option');
        opt.value = s.sales_uid;
        opt.textContent = s.sales_name;
        select.appendChild(opt);
      });
    }
  },

  async loadStageOptions() {
    const result = await Api.call('readLookupOptions', Api.withBusiness({}));
    const data = (result.success && result.data) || {};
    State.lookupData = data;
    State.lookupStages = data.pipeline_stage || [];

    const fill = (elId, values) => {
      const el = document.getElementById(elId);
      (values || []).forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = v;
        el.appendChild(opt);
      });
    };
    fill('filter-stage', data.pipeline_stage);
    fill('explorer-lead-source', data.lead_source);
    fill('filter-lead-source', data.lead_source);
    fill('filter-product', data.product_type);
  }
};

/* ============================================================
   12. HALAMAN OVERVIEW
   ============================================================ */
const OverviewPage = {
  async load() {
    const isDefaultFilter = !State.filters.date_from && !State.filters.date_to &&
      !State.filters.sales_uid && !State.filters.pipeline_stage &&
      !State.filters.lead_source && !State.filters.product_type;

    const cached = isDefaultFilter ? OverviewCache.get() : null;
    const updatedAtEl = document.getElementById('overview-updated-at');

    if (cached) {
      document.getElementById('overview-loading').hidden = true;
      document.getElementById('overview-content').hidden = false;
      State.overviewData = cached.overviewData;
      State.trendData = cached.trendData;
      this.renderKpi(cached.overviewData.kpi);
      this.renderWidgets(cached.overviewData);
      this.renderAllCharts();
      updatedAtEl.textContent = 'Data per ' + OverviewCache.formatSavedAt(cached.savedAt) + ' — memperbarui...';
    } else {
      document.getElementById('overview-loading').hidden = false;
      LoadingIndicator.start('overview-loading');
      document.getElementById('overview-content').hidden = true;
      updatedAtEl.textContent = '';
    }

    const payload = Api.withBusiness({});
    if (State.filters.date_from) payload.date_from = State.filters.date_from;
    if (State.filters.date_to) payload.date_to = State.filters.date_to;
    if (State.filters.sales_uid) payload.sales_uid = State.filters.sales_uid;
    if (State.filters.pipeline_stage) payload.pipeline_stage = State.filters.pipeline_stage;
    if (State.filters.lead_source) payload.lead_source = State.filters.lead_source;
    if (State.filters.product_type) payload.product_type = State.filters.product_type;

    const trendPayload = Api.withBusiness({ granularity: State.trendGranularity });
    if (State.filters.sales_uid) trendPayload.sales_uid = State.filters.sales_uid;

    const [result, trendResult] = await Promise.all([
      Api.call('readManagerOverview', payload),
      Api.call('readTrendData', trendPayload)
    ]);
    const trendData = (trendResult.success && trendResult.data) ? trendResult.data : [];

    if (!cached) {
      document.getElementById('overview-loading').hidden = true;
      LoadingIndicator.stop('overview-loading');
    }

    if (!result.success) {
      if (cached) {
        updatedAtEl.textContent = 'Data per ' + OverviewCache.formatSavedAt(cached.savedAt) + ' — gagal memperbarui, cek koneksi';
      } else {
        Snackbar.show(result.message || 'Gagal memuat data overview', 'error');
      }
      return;
    }

    State.overviewData = result.data;
    State.trendData = trendData;
    document.getElementById('overview-content').hidden = false;

    this.renderKpi(result.data.kpi);
    this.renderWidgets(result.data);
    this.renderAllCharts();

    if (isDefaultFilter) {
      OverviewCache.save(result.data, trendData);
      updatedAtEl.textContent = 'Data per ' + OverviewCache.formatSavedAt(Date.now());
    } else {
      updatedAtEl.textContent = '';
    }
  },

  renderKpi(kpi) {
    document.getElementById('kpi-total-projects').textContent = kpi.total_projects;
    document.getElementById('kpi-pipeline-value').textContent = Utils.formatCurrency(kpi.total_pipeline_value);
    document.getElementById('kpi-won-value').textContent = Utils.formatCurrency(kpi.won_value);
    document.getElementById('kpi-win-rate').textContent = kpi.win_rate_percent + '%';
    document.getElementById('kpi-total-activities').textContent = kpi.total_activities_period;
  },

  renderWidgets(data) {
    const staleEl = document.getElementById('widget-stale-list');
    staleEl.innerHTML = data.stale_projects.length === 0
      ? '<p class="empty-state">Tidak ada project yang butuh perhatian.</p>'
      : data.stale_projects.map((p) =>
          '<div class="widget-item"><div class="widget-item-title">' + p.project_name + '</div>' +
          '<div class="widget-item-sub">' + p.sales_name + ' · Tidak ada aktivitas ' + p.days_since_activity + ' hari</div></div>'
        ).join('');

    const followupEl = document.getElementById('widget-followup-list');
    followupEl.innerHTML = data.followups_today.length === 0
      ? '<p class="empty-state">Tidak ada follow up jatuh tempo hari ini.</p>'
      : data.followups_today.map((f) =>
          '<div class="widget-item"><div class="widget-item-title">' + f.project_name + '</div>' +
          '<div class="widget-item-sub">' + f.sales_name + '</div></div>'
        ).join('');

    const recentEl = document.getElementById('widget-recent-list');
    recentEl.innerHTML = data.recent_activities.length === 0
      ? '<p class="empty-state">Belum ada aktivitas.</p>'
      : data.recent_activities.map((a) =>
          '<div class="widget-item"><div class="widget-item-title">' + a.project_name + ' — ' + a.activity_type + '</div>' +
          '<div class="widget-item-sub">' + a.sales_name + ' · ' + Utils.formatShortDate(a.timestamp) + '</div></div>'
        ).join('');
  },

  async loadTrend() {
    const payload = Api.withBusiness({ granularity: State.trendGranularity });
    if (State.filters.sales_uid) payload.sales_uid = State.filters.sales_uid;
    const result = await Api.call('readTrendData', payload);
    State.trendData = (result.success && result.data) ? result.data : [];
  },

  renderAllCharts() {
    if (!State.overviewData) return;
    this.renderFunnelChart(State.overviewData.funnel);
    this.renderStatusPie(State.overviewData.status_breakdown);
    this.renderTrendChart(State.trendData || []);
    this.renderSalesRankingChart(State.overviewData.sales_ranking);
    this.renderLostReasonsPie(State.overviewData.lost_reasons);
    this.renderLeadSourcePie(State.overviewData.lead_source_breakdown || {});
    this.renderProductTypePie(State.overviewData.product_breakdown || {});
  },

  destroyChart(key) { if (State.charts[key]) { State.charts[key].destroy(); delete State.charts[key]; } },

  renderFunnelChart(funnel) {
    this.destroyChart('funnel');
    const baseStages = (State.lookupStages && State.lookupStages.length > 0)
      ? State.lookupStages.slice()
      : ['New Visit', 'Perlu Estimasi Harga', 'Penawaran Siap', 'Won', 'Lost'];
    Object.keys(funnel).forEach((s) => { if (!baseStages.includes(s)) baseStages.push(s); });

    const labels = baseStages;
    const values = baseStages.map((s) => funnel[s] || 0);

    const ctx = document.getElementById('chart-funnel').getContext('2d');
    State.charts.funnel = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: Utils.chartPalette[0], borderRadius: 6 }] },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: Utils.chartTextColor(), stepSize: 1 }, grid: { color: Utils.chartGridColor() } },
          y: { ticks: { color: Utils.chartTextColor() }, grid: { display: false } }
        }
      }
    });
  },

  renderStatusPie(status) {
    this.destroyChart('statusPie');
    const ctx = document.getElementById('chart-status-pie').getContext('2d');
    State.charts.statusPie = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: ['Won', 'Lost', 'Masih Berjalan'],
        datasets: [{ data: [status.won, status.lost, status.ongoing], backgroundColor: [Utils.chartPalette[1], Utils.chartPalette[3], Utils.chartPalette[0]] }]
      },
      options: { plugins: { legend: { position: 'bottom', labels: { color: Utils.chartTextColor() } } } }
    });
  },

  renderTrendChart(trend) {
    this.destroyChart('trend');
    const ctx = document.getElementById('chart-trend').getContext('2d');
    State.charts.trend = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trend.map((t) => t.label),
        datasets: [
          { label: 'Visit', data: trend.map((t) => t.visit_count), borderColor: Utils.chartPalette[0], tension: 0.3 },
          { label: 'Won', data: trend.map((t) => t.won_count), borderColor: Utils.chartPalette[1], tension: 0.3 },
          { label: 'Lost', data: trend.map((t) => t.lost_count), borderColor: Utils.chartPalette[3], tension: 0.3 }
        ]
      },
      options: {
        plugins: { legend: { position: 'bottom', labels: { color: Utils.chartTextColor() } } },
        scales: {
          x: { ticks: { color: Utils.chartTextColor() }, grid: { color: Utils.chartGridColor() } },
          y: { ticks: { color: Utils.chartTextColor() }, grid: { color: Utils.chartGridColor() }, beginAtZero: true }
        }
      }
    });
  },

  renderSalesRankingChart(ranking) {
    this.destroyChart('salesRanking');
    const ctx = document.getElementById('chart-sales-ranking').getContext('2d');
    State.charts.salesRanking = new Chart(ctx, {
      type: 'bar',
      data: { labels: ranking.map((r) => r.sales_name), datasets: [{ data: ranking.map((r) => r.total_activities), backgroundColor: Utils.chartPalette[2], borderRadius: 6 }] },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: Utils.chartTextColor() }, grid: { display: false } },
          y: { ticks: { color: Utils.chartTextColor() }, grid: { color: Utils.chartGridColor() } }
        }
      }
    });
  },

  renderLostReasonsPie(reasons) {
    this.destroyChart('lostReasons');
    const ctx = document.getElementById('chart-lost-reasons').getContext('2d');
    const labels = Object.keys(reasons);
    State.charts.lostReasons = new Chart(ctx, {
      type: 'pie',
      data: { labels, datasets: [{ data: labels.map((l) => reasons[l]), backgroundColor: Utils.chartPalette }] },
      options: { plugins: { legend: { position: 'bottom', labels: { color: Utils.chartTextColor() } } } }
    });
  },

  renderLeadSourcePie(sources) {
    this.destroyChart('leadSource');
    const ctx = document.getElementById('chart-lead-source').getContext('2d');
    const labels = Object.keys(sources);
    State.charts.leadSource = new Chart(ctx, {
      type: 'pie',
      data: { labels, datasets: [{ data: labels.map((l) => sources[l]), backgroundColor: Utils.chartPalette }] },
      options: { plugins: { legend: { position: 'bottom', labels: { color: Utils.chartTextColor() } } } }
    });
  },

  renderProductTypePie(products) {
    this.destroyChart('productType');
    const ctx = document.getElementById('chart-product-type').getContext('2d');
    const labels = Object.keys(products);
    State.charts.productType = new Chart(ctx, {
      type: 'pie',
      data: { labels, datasets: [{ data: labels.map((l) => products[l]), backgroundColor: Utils.chartPalette }] },
      options: { plugins: { legend: { position: 'bottom', labels: { color: Utils.chartTextColor() } } } }
    });
  },

  initGranularityToggle() {
    document.getElementById('trend-granularity-chips').addEventListener('click', async (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('#trend-granularity-chips .chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      State.trendGranularity = chip.dataset.granularity;
      await this.loadTrend();
      this.renderTrendChart(State.trendData || []);
    });
  }
};

/* ============================================================
   13. HALAMAN PROJECT EXPLORER
   ============================================================ */
const ExplorerPage = {
  init() {
    document.getElementById('btn-explorer-search').addEventListener('click', () => this.load());
    document.getElementById('explorer-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.load(); });
  },

  async load() {
    document.getElementById('explorer-loading').hidden = false;
    LoadingIndicator.start('explorer-loading');
    document.getElementById('explorer-table-wrap').hidden = true;

    const payload = Api.withBusiness({});
    const keyword = document.getElementById('explorer-search').value.trim();
    const leadSource = document.getElementById('explorer-lead-source').value;
    if (keyword) payload.keyword = keyword;
    if (leadSource) payload.lead_source = leadSource;
    if (State.filters.date_from) payload.date_from = State.filters.date_from;
    if (State.filters.date_to) payload.date_to = State.filters.date_to;
    if (State.filters.sales_uid) payload.sales_uid = State.filters.sales_uid;
    if (State.filters.pipeline_stage) payload.pipeline_stage = State.filters.pipeline_stage;

    const result = await Api.call('readProjectExplorer', payload);

    document.getElementById('explorer-loading').hidden = true;
    LoadingIndicator.stop('explorer-loading');
    document.getElementById('explorer-table-wrap').hidden = false;
    State.explorerLoaded = true;

    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat daftar project', 'error'); return; }
    this.render(result.data || []);
  },

  render(projects) {
    const tbody = document.getElementById('explorer-table-body');
    const emptyEl = document.getElementById('explorer-empty');

    if (projects.length === 0) { tbody.innerHTML = ''; emptyEl.hidden = false; return; }
    emptyEl.hidden = true;

    tbody.innerHTML = projects.map((p, index) => {
      const valueText = p.estimated_value ? Utils.formatCurrency(p.estimated_value) : '-';
      const leadSource = p.lead_source || '-';
      const ageText = (p.lead_age_days === null || p.lead_age_days === undefined) ? '-' : p.lead_age_days + ' hari';
      return '<tr data-project-id="' + p.project_id + '" data-project-name="' + p.project_name + '" data-project-stage="' + p.pipeline_stage + '" data-project-value="' + valueText + '" data-project-address="' + (p.location_address || '-') + '" data-project-lead-source="' + leadSource + '">' +
        '<td>' + (index + 1) + '</td>' +
        '<td>' + p.project_name + '</td>' +
        '<td>' + p.sales_name + '</td>' +
        '<td>' + p.pipeline_stage + '</td>' +
        '<td>' + leadSource + '</td>' +
        '<td>' + valueText + '</td>' +
        '<td>' + (p.location_address || '-') + '</td>' +
        '<td>' + ageText + '</td>' +
        '<td>' + Utils.formatShortDate(p.date_last_activity) + '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('tr').forEach((row) => {
      row.addEventListener('click', () => {
        DetailModal.open(
          row.dataset.projectId, row.dataset.projectName, row.dataset.projectStage,
          row.dataset.projectValue, row.dataset.projectAddress, row.dataset.projectLeadSource
        );
      });
    });
  }
};

/* ============================================================
   14. MODAL DETAIL PROJECT
   ============================================================ */
const DetailModal = {
  init() {
    document.getElementById('btn-close-detail').addEventListener('click', () => this.close());
    document.getElementById('project-detail-overlay').addEventListener('click', (e) => { if (e.target.id === 'project-detail-overlay') this.close(); });
    document.getElementById('btn-close-lightbox').addEventListener('click', () => Lightbox.close());
    document.getElementById('photo-lightbox').addEventListener('click', (e) => { if (e.target.id === 'photo-lightbox') Lightbox.close(); });
  },

  async open(projectId, projectName, stage, valueText, address, leadSource) {
    document.getElementById('detail-project-name').textContent = projectName;
    document.getElementById('detail-project-stage').textContent = stage;
    document.getElementById('detail-project-value').textContent = valueText;
    document.getElementById('detail-project-address').textContent = address;
    document.getElementById('detail-project-lead-source').textContent = (leadSource && leadSource !== '-') ? 'Sumber: ' + leadSource : '';
    document.getElementById('detail-contacts').innerHTML = '<p class="empty-state">Memuat kontak...</p>';
    document.getElementById('detail-photo-grid').innerHTML = '';
    document.getElementById('detail-timeline').innerHTML = '<p class="loading-text">Memuat riwayat...</p>';

    document.getElementById('project-detail-overlay').hidden = false;

    const [contactsResult, timelineResult] = await Promise.all([
      Api.call('readProjectContacts', { project_id: projectId }),
      Api.call('readActivityTimeline', { project_id: projectId })
    ]);

    this.renderContacts(contactsResult.success ? contactsResult.data : []);
    this.renderTimelineAndPhotos(timelineResult.success ? timelineResult.data : []);
  },

  close() { document.getElementById('project-detail-overlay').hidden = true; },

  renderContacts(contacts) {
    const el = document.getElementById('detail-contacts');
    if (!contacts || contacts.length === 0) { el.innerHTML = ''; return; }
    el.innerHTML = contacts.map((c) => {
      const digits = String(c.phone_number).replace(/\D/g, '');
      const waNumber = digits.startsWith('0') ? '62' + digits.slice(1) : digits;
      return '<div class="contact-item">' +
        '<div class="contact-name-row">' + c.contact_name + ' (' + c.role + ')</div>' +
        '<a href="tel:' + digits + '" class="contact-link">Telpon</a>' +
        '<a href="https://wa.me/' + waNumber + '" target="_blank" rel="noopener" class="contact-link">WhatsApp</a>' +
        '</div>';
    }).join('');
  },

  renderTimelineAndPhotos(activities) {
    const timelineEl = document.getElementById('detail-timeline');
    const photoGridEl = document.getElementById('detail-photo-grid');

    if (!activities || activities.length === 0) {
      timelineEl.innerHTML = '<p class="empty-state">Belum ada aktivitas.</p>';
      photoGridEl.innerHTML = '';
      return;
    }

    const allPhotos = [];
    activities.forEach((a) => { if (a.photos) a.photos.forEach((p) => allPhotos.push(p.url)); });
    photoGridEl.innerHTML = allPhotos.length === 0
      ? '<p class="empty-state">Belum ada foto.</p>'
      : allPhotos.map((url) => '<img src="' + url + '" alt="Foto project" loading="lazy" data-full="' + url + '" />').join('');

    photoGridEl.querySelectorAll('img').forEach((img) => { img.addEventListener('click', () => Lightbox.open(img.dataset.full)); });

    timelineEl.innerHTML = activities.map((a) =>
      '<div class="timeline-item">' +
      '<p class="timeline-date">' + Utils.formatShortDate(a.timestamp) + ' · ' + a.activity_type + '</p>' +
      '<p class="timeline-note">' + a.activity_note + '</p>' +
      '</div>'
    ).join('');
  }
};

/* ============================================================
   15. LIGHTBOX FOTO
   ============================================================ */
const Lightbox = {
  open(url) { document.getElementById('lightbox-image').src = url; document.getElementById('photo-lightbox').hidden = false; },
  close() { document.getElementById('photo-lightbox').hidden = true; }
};

/* ============================================================
   16. HALAMAN PERFORMA SALES
   ============================================================ */
const PerformancePage = {
  async load() {
    document.getElementById('performance-loading').hidden = false;
    LoadingIndicator.start('performance-loading');
    document.getElementById('performance-content').hidden = true;

    const payload = Api.withBusiness({});
    if (State.filters.date_from) payload.date_from = State.filters.date_from;
    if (State.filters.date_to) payload.date_to = State.filters.date_to;

    const result = await Api.call('readSalesPerformance', payload);

    document.getElementById('performance-loading').hidden = true;
    LoadingIndicator.stop('performance-loading');
    document.getElementById('performance-content').hidden = false;
    State.performanceLoaded = true;

    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat data performa sales', 'error'); return; }
    this.render(result.data || []);
  },

  render(performance) {
    const tbody = document.getElementById('performance-table-body');
    if (performance.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7"><p class="empty-state">Belum ada data aktivitas.</p></td></tr>';
      return;
    }
    tbody.innerHTML = performance.map((p) =>
      '<tr data-sales-uid="' + p.sales_uid + '" data-sales-name="' + p.sales_name + '">' +
      '<td><strong>' + p.sales_name + '</strong></td>' +
      '<td>' + p.total_activities + '</td>' +
      '<td>' + p.visit_count + '</td>' +
      '<td>' + p.won_count + '</td>' +
      '<td>' + p.lost_count + '</td>' +
      '<td>' + Utils.formatCurrency(p.won_value) + '</td>' +
      '<td>' + p.active_projects_count + '</td>' +
      '</tr>'
    ).join('');

    tbody.querySelectorAll('tr').forEach((row) => {
      row.addEventListener('click', () => this.loadDetail(row.dataset.salesUid, row.dataset.salesName));
    });
  },

  async loadDetail(salesUid, salesName) {
    document.getElementById('performance-detail').hidden = false;
    document.getElementById('performance-detail-title').textContent = 'Detail — ' + salesName;
    document.getElementById('performance-detail-kpi').innerHTML = '<p class="loading-text">Memuat...</p>';

    const overviewPayload = Api.withBusiness({ sales_uid: salesUid });
    if (State.filters.date_from) overviewPayload.date_from = State.filters.date_from;
    if (State.filters.date_to) overviewPayload.date_to = State.filters.date_to;

    const [overviewResult, trendResult] = await Promise.all([
      Api.call('readManagerOverview', overviewPayload),
      Api.call('readTrendData', Api.withBusiness({ granularity: State.trendGranularity, sales_uid: salesUid }))
    ]);

    if (overviewResult.success) {
      const kpi = overviewResult.data.kpi;
      document.getElementById('performance-detail-kpi').innerHTML =
        '<div class="kpi-card glow-primary"><span class="kpi-label">Total Project</span><span class="kpi-value">' + kpi.total_projects + '</span></div>' +
        '<div class="kpi-card glow-success"><span class="kpi-label">Nilai Pipeline</span><span class="kpi-value">' + Utils.formatCurrency(kpi.total_pipeline_value) + '</span></div>' +
        '<div class="kpi-card glow-warning"><span class="kpi-label">Win Rate</span><span class="kpi-value">' + kpi.win_rate_percent + '%</span></div>' +
        '<div class="kpi-card glow-danger"><span class="kpi-label">Total Aktivitas</span><span class="kpi-value">' + kpi.total_activities_period + '</span></div>';
    }

    if (trendResult.success) this.renderTrendChart(trendResult.data || []);
    document.getElementById('performance-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  renderTrendChart(trend) {
    if (State.charts.performanceTrend) State.charts.performanceTrend.destroy();
    const ctx = document.getElementById('chart-performance-trend').getContext('2d');
    State.charts.performanceTrend = new Chart(ctx, {
      type: 'line',
      data: {
        labels: trend.map((t) => t.label),
        datasets: [
          { label: 'Visit', data: trend.map((t) => t.visit_count), borderColor: Utils.chartPalette[0], tension: 0.3 },
          { label: 'Won', data: trend.map((t) => t.won_count), borderColor: Utils.chartPalette[1], tension: 0.3 },
          { label: 'Lost', data: trend.map((t) => t.lost_count), borderColor: Utils.chartPalette[3], tension: 0.3 }
        ]
      },
      options: {
        plugins: { legend: { position: 'bottom', labels: { color: Utils.chartTextColor() } } },
        scales: {
          x: { ticks: { color: Utils.chartTextColor() }, grid: { color: Utils.chartGridColor() } },
          y: { ticks: { color: Utils.chartTextColor() }, grid: { color: Utils.chartGridColor() }, beginAtZero: true }
        }
      }
    });
  }
};

/* ============================================================
   17. HALAMAN LOG AKTIVITAS
   ============================================================ */
const LogPage = {
  init() {
    document.getElementById('btn-log-filter').addEventListener('click', () => { State.logOffset = 0; this.load(); });
    document.getElementById('btn-log-prev').addEventListener('click', () => {
      if (State.logOffset - State.logLimit >= 0) { State.logOffset -= State.logLimit; this.load(); }
    });
    document.getElementById('btn-log-next').addEventListener('click', () => {
      if (State.logOffset + State.logLimit < State.logTotalCount) { State.logOffset += State.logLimit; this.load(); }
    });
  },

  async load() {
    document.getElementById('log-loading').hidden = false;
    LoadingIndicator.start('log-loading');
    document.getElementById('log-table-wrap').hidden = true;

    const payload = Api.withBusiness({ limit: State.logLimit, offset: State.logOffset });
    if (State.filters.date_from) payload.date_from = State.filters.date_from;
    if (State.filters.date_to) payload.date_to = State.filters.date_to;
    if (State.filters.sales_uid) payload.sales_uid = State.filters.sales_uid;
    const activityType = document.getElementById('log-activity-type').value;
    if (activityType) payload.activity_type = activityType;

    const result = await Api.call('readActivityLog', payload);

    document.getElementById('log-loading').hidden = true;
    LoadingIndicator.stop('log-loading');
    document.getElementById('log-table-wrap').hidden = false;
    State.logLoaded = true;

    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat log aktivitas', 'error'); return; }

    State.logTotalCount = result.data.total_count;
    this.render(result.data.activities || []);
    this.renderPagination();
  },

  render(activities) {
    const tbody = document.getElementById('log-table-body');
    const emptyEl = document.getElementById('log-empty');
    if (activities.length === 0) { tbody.innerHTML = ''; emptyEl.hidden = false; return; }
    emptyEl.hidden = true;

    tbody.innerHTML = activities.map((a) =>
      '<tr>' +
      '<td>' + Utils.formatShortDate(a.timestamp) + '</td>' +
      '<td>' + a.project_name + '</td>' +
      '<td>' + a.sales_name + '</td>' +
      '<td>' + a.activity_type + '</td>' +
      '<td>' + (a.note || '-') + '</td>' +
      '<td>' + (a.pipeline_stage || '-') + '</td>' +
      '</tr>'
    ).join('');
  },

  renderPagination() {
    const start = State.logTotalCount === 0 ? 0 : State.logOffset + 1;
    const end = Math.min(State.logOffset + State.logLimit, State.logTotalCount);
    document.getElementById('log-page-info').textContent = start + '–' + end + ' dari ' + State.logTotalCount;
    document.getElementById('btn-log-prev').disabled = State.logOffset === 0;
    document.getElementById('btn-log-next').disabled = (State.logOffset + State.logLimit) >= State.logTotalCount;
  }
};

/* ============================================================
   18. EXPORT (Excel + Print)
   ============================================================ */
const ExportManager = {
  init() {
    document.getElementById('btn-export-excel').addEventListener('click', () => this.exportExcel());
    document.getElementById('btn-print-pdf').addEventListener('click', () => window.print());
  },
  exportExcel() {
    if (!State.overviewData) { Snackbar.show('Data belum dimuat, coba lagi sebentar', 'error'); return; }
    const d = State.overviewData;
    const wb = XLSX.utils.book_new();

    const kpiSheet = XLSX.utils.aoa_to_sheet([
      ['Ringkasan KPI'],
      ['Total Project', d.kpi.total_projects],
      ['Nilai Pipeline Aktif', d.kpi.total_pipeline_value],
      ['Nilai Deal Won', d.kpi.won_value],
      ['Win Rate (%)', d.kpi.win_rate_percent],
      ['Total Aktivitas (Periode)', d.kpi.total_activities_period]
    ]);
    XLSX.utils.book_append_sheet(wb, kpiSheet, 'Ringkasan');

    const rankingRows = [['Sales', 'Total Aktivitas', 'Visit', 'Won', 'Lost', 'Nilai Won']];
    d.sales_ranking.forEach((r) => rankingRows.push([r.sales_name, r.total_activities, r.visit_count, r.won_count, r.lost_count, r.won_value]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rankingRows), 'Ranking Sales');

    const activityRows = [['Project', 'Sales', 'Jenis Aktivitas', 'Catatan', 'Tanggal']];
    d.recent_activities.forEach((a) => activityRows.push([a.project_name, a.sales_name, a.activity_type, a.note, a.timestamp]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(activityRows), 'Aktivitas Terbaru');

    XLSX.writeFile(wb, 'SVS_Manager_Report_' + State.businessId + '_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  }
};

/* ============================================================
   19. ADMIN CONSOLE
   ============================================================ */
const AdminConsole = {
  init() {
    document.querySelectorAll('.admin-subnav button').forEach((btn) => {
      btn.addEventListener('click', () => this.goTo(btn.dataset.adminPanel));
    });

    const isSuperAdmin = State.user.role === 'super_admin';
    document.getElementById('admin-subnav-price').hidden = !isSuperAdmin;
    document.getElementById('admin-subnav-projects').hidden = !isSuperAdmin;
    document.getElementById('admin-subnav-users').hidden = !isSuperAdmin;
    document.getElementById('admin-subnav-settings').hidden = !isSuperAdmin;

    AdminLookup.init();
    if (isSuperAdmin) { AdminPriceManager.init(); AdminProjects.init(); AdminUsers.init(); AdminSettings.init(); }
  },
  goTo(panel) {
    document.querySelectorAll('.admin-subnav button').forEach((b) => b.classList.toggle('active', b.dataset.adminPanel === panel));
    document.querySelectorAll('.admin-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('admin-panel-' + panel).classList.add('active');
    if (panel === 'price' && !State.priceCatalogLoaded) AdminPriceManager.load();
    if (panel === 'projects') AdminProjects.load();
    if (panel === 'users' && !State.usersLoaded) AdminUsers.load();
    if (panel === 'settings' && !State.settingsLoaded) AdminSettings.load();
  }
};

/* ---- 19a-2. Kelola Project (super_admin) — hapus (soft-delete) project ---- */
const AdminProjects = {
  mode: 'active',
  trashType: 'project',

  init() {
    document.getElementById('btn-kp-search').addEventListener('click', () => this.load());
    document.getElementById('kp-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.load(); });
    document.getElementById('kp-mode-active').addEventListener('click', () => this.switchMode('active'));
    document.getElementById('kp-mode-trash').addEventListener('click', () => this.switchMode('trash'));
    document.getElementById('kp-trash-type-project').addEventListener('click', () => this.switchTrashType('project'));
    document.getElementById('kp-trash-type-quotation').addEventListener('click', () => this.switchTrashType('quotation'));
    this.optionsLoaded = false;
  },

  switchMode(mode) {
    this.mode = mode;
    document.getElementById('kp-mode-active').classList.toggle('active', mode === 'active');
    document.getElementById('kp-mode-trash').classList.toggle('active', mode === 'trash');
    document.getElementById('kp-active-toolbar').hidden = mode !== 'active';
    document.getElementById('kp-table-wrap').hidden = true;
    document.getElementById('kp-trash-wrap').hidden = true;
    document.getElementById('kp-mode-desc').textContent = mode === 'active'
      ? 'Daftar seluruh project pada bisnis yang aktif (lihat switcher di kanan atas). Hapus project di sini memindahkannya ke "Sampah" — datanya tidak langsung hilang permanen, tapi tidak akan muncul lagi di Sales App/Dashboard manapun.'
      : 'Berisi 2 jenis data yang dihapus: Project (Sales App) dan Quotation (Project Estimator) — pilih jenisnya di bawah. Bisa dipulihkan kapan saja, atau dihapus PERMANEN (tidak bisa dibatalkan).';
    this.load();
  },

  switchTrashType(type) {
    this.trashType = type;
    document.getElementById('kp-trash-type-project').classList.toggle('active', type === 'project');
    document.getElementById('kp-trash-type-quotation').classList.toggle('active', type === 'quotation');
    document.getElementById('kp-trash-project-section').hidden = type !== 'project';
    document.getElementById('kp-trash-quotation-section').hidden = type !== 'quotation';
    if (type === 'project') this.loadTrash();
    else this.loadTrashQuotations();
  },

  async loadFilterOptions() {
    if (this.optionsLoaded) return;
    this.optionsLoaded = true;

    const [salesResult, lookupResult] = await Promise.all([
      Api.call('readSalesList', Api.withBusiness({})),
      Api.call('readLookupOptions', Api.withBusiness({}))
    ]);

    const salesSelect = document.getElementById('kp-sales');
    if (salesResult.success) {
      (salesResult.data || []).forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.sales_uid; opt.textContent = s.sales_name;
        salesSelect.appendChild(opt);
      });
    }
    const stageSelect = document.getElementById('kp-stage');
    if (lookupResult.success) {
      (lookupResult.data.pipeline_stage || []).forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        stageSelect.appendChild(opt);
      });
    }
  },

  async load() {
    if (this.mode === 'trash') {
      return this.trashType === 'quotation' ? this.loadTrashQuotations() : this.loadTrash();
    }

    await this.loadFilterOptions();

    document.getElementById('kp-loading').hidden = false;
    LoadingIndicator.start('kp-loading');
    document.getElementById('kp-table-wrap').hidden = true;

    const payload = Api.withBusiness({});
    const keyword = document.getElementById('kp-search').value.trim();
    const salesUid = document.getElementById('kp-sales').value;
    const stage = document.getElementById('kp-stage').value;
    if (keyword) payload.keyword = keyword;
    if (salesUid) payload.sales_uid = salesUid;
    if (stage) payload.pipeline_stage = stage;

    const result = await Api.call('readProjectExplorer', payload);

    document.getElementById('kp-loading').hidden = true;
    LoadingIndicator.stop('kp-loading');
    document.getElementById('kp-table-wrap').hidden = false;

    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat daftar project', 'error'); return; }
    this.render(result.data || []);
  },

  render(projects) {
    const tbody = document.getElementById('kp-table-body');
    const emptyEl = document.getElementById('kp-empty');
    if (projects.length === 0) { tbody.innerHTML = ''; emptyEl.hidden = false; return; }
    emptyEl.hidden = true;

    tbody.innerHTML = projects.map((p, index) => {
      const ageText = (p.lead_age_days === null || p.lead_age_days === undefined) ? '-' : p.lead_age_days + ' hari';
      const valueText = p.estimated_value ? Utils.formatCurrency(p.estimated_value) : '-';
      return '<tr class="row-clickable" data-project-id="' + p.project_id + '" data-project-name="' + p.project_name + '" data-project-stage="' + p.pipeline_stage + '" data-project-value="' + valueText + '" data-project-address="' + (p.location_address || '-') + '" data-project-lead-source="' + (p.lead_source || '-') + '">' +
        '<td>' + (index + 1) + '</td>' +
        '<td>' + p.project_name + '</td>' +
        '<td>' + p.sales_name + '</td>' +
        '<td>' + p.pipeline_stage + '</td>' +
        '<td>' + valueText + '</td>' +
        '<td>' + ageText + '</td>' +
        '<td>' + Utils.formatShortDate(p.date_last_activity) + '</td>' +
        '<td class="row-actions"><button type="button" class="danger" data-delete-project="' + p.project_id + '" data-project-name="' + p.project_name + '">Hapus</button></td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('tr[data-project-id]').forEach((row) => {
      row.addEventListener('click', () => {
        DetailModal.open(
          row.dataset.projectId, row.dataset.projectName, row.dataset.projectStage,
          row.dataset.projectValue, row.dataset.projectAddress, row.dataset.projectLeadSource
        );
      });
    });
    tbody.querySelectorAll('[data-delete-project]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // supaya klik tombol Hapus tidak ikut membuka pop-up detail
        this.deleteProject(btn.dataset.deleteProject, btn.dataset.projectName);
      });
    });
  },

  async deleteProject(projectId, projectName) {
    if (!confirm('Hapus project "' + projectName + '"? Project akan dipindahkan ke Sampah — tidak muncul lagi di Sales App/Dashboard manapun.')) return;

    const result = await Api.call('deleteProject', { project_id: projectId });
    if (!result.success) { Snackbar.show(result.message || 'Gagal menghapus project', 'error'); return; }

    Snackbar.show('Project dihapus', 'success');
    this.load();
  },

  /* ---- Sampah ---- */
  async loadTrash() {
    document.getElementById('kp-loading').hidden = false;
    LoadingIndicator.start('kp-loading');
    document.getElementById('kp-trash-wrap').hidden = true;

    const result = await Api.call('readDeletedProjects', Api.withBusiness({}));

    document.getElementById('kp-loading').hidden = true;
    LoadingIndicator.stop('kp-loading');
    document.getElementById('kp-trash-wrap').hidden = false;

    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat Sampah', 'error'); return; }
    this.renderTrash(result.data || []);
  },

  renderTrash(projects) {
    const tbody = document.getElementById('kp-trash-table-body');
    const emptyEl = document.getElementById('kp-trash-empty');
    if (projects.length === 0) { tbody.innerHTML = ''; emptyEl.hidden = false; return; }
    emptyEl.hidden = true;

    tbody.innerHTML = projects.map((p, index) => {
      const valueText = p.estimated_value ? Utils.formatCurrency(p.estimated_value) : '-';
      return '<tr class="row-clickable" data-project-id="' + p.project_id + '" data-project-name="' + p.project_name + '" data-project-stage="' + p.pipeline_stage + '" data-project-value="' + valueText + '" data-project-address="' + (p.location_address || '-') + '" data-project-lead-source="' + (p.lead_source || '-') + '">' +
      '<td>' + (index + 1) + '</td>' +
      '<td>' + p.project_name + '</td>' +
      '<td>' + p.sales_name + '</td>' +
      '<td>' + p.pipeline_stage + '</td>' +
      '<td>' + p.deleted_by_name + '</td>' +
      '<td>' + Utils.formatShortDate(p.deleted_at) + '</td>' +
      '<td class="row-actions">' +
      '<button type="button" data-restore="' + p.project_id + '" data-name="' + p.project_name + '">Pulihkan</button>' +
      '<button type="button" class="danger" data-permanent-delete="' + p.project_id + '" data-name="' + p.project_name + '">Hapus Permanen</button>' +
      '</td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('tr[data-project-id]').forEach((row) => {
      row.addEventListener('click', () => {
        DetailModal.open(
          row.dataset.projectId, row.dataset.projectName, row.dataset.projectStage,
          row.dataset.projectValue, row.dataset.projectAddress, row.dataset.projectLeadSource
        );
      });
    });
    tbody.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.restoreProject(btn.dataset.restore, btn.dataset.name);
      });
    });
    tbody.querySelectorAll('[data-permanent-delete]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.permanentlyDelete(btn.dataset.permanentDelete, btn.dataset.name);
      });
    });
  },

  async restoreProject(projectId, projectName) {
    if (!confirm('Pulihkan project "' + projectName + '"? Project akan muncul lagi normal di Sales App & Dashboard.')) return;

    const result = await Api.call('restoreProject', { project_id: projectId });
    if (!result.success) { Snackbar.show(result.message || 'Gagal memulihkan project', 'error'); return; }

    Snackbar.show('Project dipulihkan', 'success');
    this.loadTrash();
  },

  async permanentlyDelete(projectId, projectName) {
    const confirmText = 'Hapus PERMANEN project "' + projectName + '"?\n\nSemua aktivitas & foto terkait IKUT TERHAPUS. TIDAK BISA DIBATALKAN.';
    if (!confirm(confirmText)) return;
    // Konfirmasi kedua khusus aksi permanen — mengurangi risiko salah klik
    if (!confirm('Yakin sekali? Ketik OK di kotak berikutnya untuk benar-benar menghapus permanen.')) return;

    const result = await Api.call('permanentlyDeleteProject', { project_id: projectId });
    if (!result.success) { Snackbar.show(result.message || 'Gagal menghapus permanen', 'error'); return; }

    Snackbar.show('Project dihapus permanen', 'success');
    this.loadTrash();
  },

  /* ---- Sampah Quotation (Project Estimator) ---- */
  async loadTrashQuotations() {
    document.getElementById('kp-loading').hidden = false;
    LoadingIndicator.start('kp-loading');

    const result = await Api.call('readDeletedQuotations', Api.withBusiness({}));

    document.getElementById('kp-loading').hidden = true;
    LoadingIndicator.stop('kp-loading');

    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat Sampah quotation', 'error'); return; }
    this.renderTrashQuotations(result.data || []);
  },

  renderTrashQuotations(quotations) {
    const tbody = document.getElementById('kp-trash-quotation-table-body');
    const emptyEl = document.getElementById('kp-trash-quotation-empty');
    if (quotations.length === 0) { tbody.innerHTML = ''; emptyEl.hidden = false; return; }
    emptyEl.hidden = true;

    tbody.innerHTML = quotations.map((q, index) => {
      const displayName = q.project_name + (q.client_name ? ' — ' + q.client_name : '');
      return '<tr>' +
        '<td>' + (index + 1) + '</td>' +
        '<td>' + displayName + '</td>' +
        '<td>' + (q.quotation_number || '-') + '</td>' +
        '<td>' + (q.status || '-') + '</td>' +
        '<td>' + Utils.formatShortDate(q.deleted_at) + '</td>' +
        '<td class="row-actions">' +
        '<button type="button" data-restore-quotation="' + q.quotation_id + '" data-name="' + displayName + '">Pulihkan</button>' +
        '<button type="button" class="danger" data-permanent-delete-quotation="' + q.quotation_id + '" data-name="' + displayName + '">Hapus Permanen</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-restore-quotation]').forEach((btn) => {
      btn.addEventListener('click', () => this.restoreQuotation(btn.dataset.restoreQuotation, btn.dataset.name));
    });
    tbody.querySelectorAll('[data-permanent-delete-quotation]').forEach((btn) => {
      btn.addEventListener('click', () => this.permanentlyDeleteQuotation(btn.dataset.permanentDeleteQuotation, btn.dataset.name));
    });
  },

  async restoreQuotation(quotationId, name) {
    if (!confirm('Pulihkan quotation "' + name + '"? Akan muncul lagi normal di Project Estimator.')) return;

    const result = await Api.call('restoreLegacyProjectAdmin', { project_id: quotationId });
    if (!result.success) { Snackbar.show(result.message || 'Gagal memulihkan quotation', 'error'); return; }

    Snackbar.show('Quotation dipulihkan', 'success');
    this.loadTrashQuotations();
  },

  async permanentlyDeleteQuotation(quotationId, name) {
    const confirmText = 'Hapus PERMANEN quotation "' + name + '"?\n\nTIDAK BISA DIBATALKAN.';
    if (!confirm(confirmText)) return;
    if (!confirm('Yakin sekali? Konfirmasi sekali lagi untuk benar-benar menghapus permanen.')) return;

    const result = await Api.call('permanentlyDeleteLegacyProjectAdmin', { project_id: quotationId });
    if (!result.success) { Snackbar.show(result.message || 'Gagal menghapus permanen', 'error'); return; }

    Snackbar.show('Quotation dihapus permanen', 'success');
    this.loadTrashQuotations();
  }
};

/* ---- 19a. Admin Lookup ---- */
const AdminLookup = {
  init() {
    const listEl = document.getElementById('lookup-category-list');
    listEl.innerHTML = LOOKUP_CATEGORIES.map((c, i) =>
      '<button type="button" data-key="' + c.key + '" class="' + (i === 0 ? 'active' : '') + '">' + c.label + '</button>'
    ).join('');
    listEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        listEl.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        State.currentLookupCategory = btn.dataset.key;
        this.renderChips();
      });
    });

    document.getElementById('btn-lookup-add').addEventListener('click', () => this.addValue());
    document.getElementById('lookup-add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.addValue(); });

    this.load();
  },

  async load() {
    const result = await Api.call('readLookupOptions', Api.withBusiness({}));
    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat data lookup', 'error'); return; }
    State.lookupData = result.data || {};
    this.renderChips();
  },

  renderChips() {
    const key = State.currentLookupCategory;
    const values = State.lookupData[key] || [];
    const el = document.getElementById('lookup-chip-list');
    const warnEl = document.getElementById('lookup-warning');

    warnEl.hidden = key !== 'pipeline_stage';

    if (values.length === 0) {
      const hasDefault = !!LOOKUP_DEFAULTS[key];
      el.innerHTML = '<p class="empty-state" style="padding: var(--space-sm) 0; width:100%;">Belum ada pilihan untuk kategori ini' +
        (hasDefault ? ' — datanya memang belum pernah diisi di server (bukan error tampilan).' : '.') + '</p>' +
        (hasDefault ? '<button type="button" id="btn-lookup-seed-default" class="secondary-button ripple">Isi dari Default Sales App</button>' : '');
      const seedBtn = document.getElementById('btn-lookup-seed-default');
      if (seedBtn) seedBtn.addEventListener('click', () => this.seedDefault());
      return;
    }

    el.innerHTML = values.map((v) =>
      '<span class="lookup-chip" draggable="true" data-value="' + v + '"><span class="lookup-chip-drag">⠿</span>' + v + '<button type="button" data-value="' + v + '">✕</button></span>'
    ).join('');
    el.querySelectorAll('.lookup-chip > button').forEach((btn) => {
      btn.addEventListener('click', () => this.removeValue(btn.dataset.value));
    });
    this.bindChipDrag(el);
  },

  /** Drag-geser urutan chip — urutan ini yang dipakai Sales App untuk urutan dropdown, jadi langsung disimpan ke server begitu selesai digeser */
  bindChipDrag(container) {
    let draggedEl = null;
    container.querySelectorAll('.lookup-chip').forEach((chip) => {
      chip.addEventListener('dragstart', () => {
        draggedEl = chip;
        setTimeout(() => chip.classList.add('dragging'), 0);
      });
      chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging');
        draggedEl = null;
        this.saveReorderedValues();
      });
      chip.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!draggedEl || draggedEl === chip) return;
        const rect = chip.getBoundingClientRect();
        const insertBefore = (e.clientX - rect.left) < rect.width / 2;
        container.insertBefore(draggedEl, insertBefore ? chip : chip.nextSibling);
      });
    });
  },

  async saveReorderedValues() {
    const key = State.currentLookupCategory;
    const el = document.getElementById('lookup-chip-list');
    const newOrder = Array.from(el.querySelectorAll('.lookup-chip')).map((c) => c.dataset.value);

    const oldOrder = State.lookupData[key] || [];
    if (JSON.stringify(newOrder) === JSON.stringify(oldOrder)) return; // tidak ada perubahan urutan

    State.lookupData[key] = newOrder;
    const result = await Api.call('updateLookupOptions', Api.withBusiness({ lookup_type: key, values: newOrder }));
    if (!result.success) { Snackbar.show(result.message || 'Gagal menyimpan urutan', 'error'); return; }
    Snackbar.show('Urutan tersimpan — otomatis ikut berubah di Sales App', 'success');
  },

  async seedDefault() {
    const key = State.currentLookupCategory;
    const defaults = LOOKUP_DEFAULTS[key];
    if (!defaults) return;

    const result = await Api.call('updateLookupOptions', Api.withBusiness({ lookup_type: key, values: defaults }));
    if (!result.success) { Snackbar.show(result.message || 'Gagal mengisi default', 'error'); return; }

    State.lookupData[key] = defaults.slice();
    this.renderChips();
    Snackbar.show('Diisi dari default — sekarang bisa diedit/dihapus manual', 'success');
  },

  async addValue() {
    const input = document.getElementById('lookup-add-input');
    const value = input.value.trim();
    if (!value) return;
    const key = State.currentLookupCategory;
    const current = State.lookupData[key] || [];
    if (current.includes(value)) { Snackbar.show('Pilihan ini sudah ada', 'error'); return; }

    const updated = current.concat([value]);
    const result = await Api.call('updateLookupOptions', Api.withBusiness({ lookup_type: key, values: updated }));
    if (!result.success) { Snackbar.show(result.message || 'Gagal menyimpan', 'error'); return; }

    State.lookupData[key] = updated;
    input.value = '';
    this.renderChips();
    Snackbar.show('Pilihan ditambahkan', 'success');
  },

  async removeValue(value) {
    const key = State.currentLookupCategory;
    const updated = (State.lookupData[key] || []).filter((v) => v !== value);
    const result = await Api.call('updateLookupOptions', Api.withBusiness({ lookup_type: key, values: updated }));
    if (!result.success) { Snackbar.show(result.message || 'Gagal menyimpan', 'error'); return; }

    State.lookupData[key] = updated;
    this.renderChips();
    Snackbar.show('Pilihan dihapus', 'success');
  }
};

/* ---- 19b. Price Manager (super_admin) ---- */
const UOM_LABELS = {
  meter_lari: 'Meter Lari', unit: 'Unit/Satuan', m2: 'M² (meter persegi)', tube_estimated: 'Tube (estimasi)'
};
function uomOptionsHtml(selected) {
  return Object.keys(UOM_LABELS).map((k) =>
    '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + UOM_LABELS[k] + '</option>'
  ).join('');
}

const AdminPriceManager = {
  init() {
    document.getElementById('btn-save-price-catalog').addEventListener('click', () => this.save());
    document.getElementById('btn-export-price-excel').addEventListener('click', () => this.exportExcel());
    document.getElementById('btn-upload-price-excel').addEventListener('click', () => document.getElementById('price-excel-file').click());
    document.getElementById('price-excel-file').addEventListener('change', (e) => this.importExcel(e.target.files[0]));
    document.getElementById('btn-add-tier').addEventListener('click', () => this.addTier());
  },

  addTier() {
    const label = prompt('Nama tier baru (mis. "ALUVE Linea (Standard line)"):');
    if (!label || !label.trim()) return;

    // Buat key otomatis dari label: huruf besar, spasi jadi underscore, buang simbol
    let key = label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!key) { Snackbar.show('Nama tier tidak valid', 'error'); return; }
    if (State.priceCatalog.brand_tiers[key]) { Snackbar.show('Tier dengan key "' + key + '" sudah ada', 'error'); return; }

    State.priceCatalog.brand_tiers[key] = { label: label.trim(), groups: [] };
    State.priceCategory = key;
    this.renderCategoryList();
    this.renderCategory();
    Snackbar.show('Tier "' + label.trim() + '" ditambahkan — klik "+ Tambah Grup Produk" untuk isi turunannya, lalu "Simpan Semua Perubahan"', 'success');
  },

  addGroup(tierKey) {
    const name = prompt('Nama grup produk baru (mis. "PINTU SWING SERIES BARU"):');
    if (!name || !name.trim()) return;
    const code = prompt('Kode grup (opsional, mis. "1.d") — boleh dikosongkan:') || '';

    State.priceCatalog.brand_tiers[tierKey].groups.push({ code: code.trim(), name: name.trim(), items: [] });
    this.renderCategory();
    Snackbar.show('Grup produk ditambahkan — klik "+ Tambah Item" untuk isi harganya', 'success');
  },

  async load() {
    State.priceCatalogLoaded = true;
    const result = await Api.call('readPriceCatalog', Api.withBusiness({}));
    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat katalog harga', 'error'); return; }

    State.priceCatalog = result.data || { brand_tiers: {}, glass: { items: [] }, other: { items: [] }, sealant: null };
    if (!State.priceCatalog.glass) State.priceCatalog.glass = { items: [] };
    if (!State.priceCatalog.other) State.priceCatalog.other = { items: [] };
    State.priceCategory = Object.keys(State.priceCatalog.brand_tiers || {})[0] || 'glass';
    this.renderCategoryList();
    this.renderCategory();
  },

  renderCategoryList() {
    const tierKeys = Object.keys(State.priceCatalog.brand_tiers || {});
    const listEl = document.getElementById('price-category-list');
    const items = tierKeys.map((k) => ({ key: k, label: (State.priceCatalog.brand_tiers[k].label || k) }));
    items.push({ key: 'glass', label: 'Kaca' });
    items.push({ key: 'other_sealant', label: 'Lain-lain & Sealant' });

    listEl.innerHTML = items.map((it) =>
      '<button type="button" data-key="' + it.key + '" class="' + (it.key === State.priceCategory ? 'active' : '') + '">' + it.label + '</button>'
    ).join('');
    listEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        State.priceCategory = btn.dataset.key;
        listEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        this.renderCategory();
      });
    });
  },

  renderCategory() {
    const key = State.priceCategory;
    const contentEl = document.getElementById('price-category-content');

    if (key === 'glass') {
      contentEl.innerHTML = this.renderFlatItemsTable(State.priceCatalog.glass.items || [], 'glass');
    } else if (key === 'other_sealant') {
      const sealant = State.priceCatalog.sealant || { name: 'SEALANT', harga_modal: 0, uom: 'tube_estimated' };
      contentEl.innerHTML =
        this.renderFlatItemsTable(State.priceCatalog.other.items || [], 'other') +
        '<div class="price-group-card"><div class="price-group-header"><strong>Sealant (item tunggal)</strong></div>' +
        '<div class="admin-form-row">' +
        '<div class="filter-field"><label>Nama</label><input class="form-input price-input" data-sealant-field="name" value="' + (sealant.name || '') + '" /></div>' +
        '<div class="filter-field"><label>Harga Modal</label><input type="number" class="form-input price-input" data-sealant-field="harga_modal" value="' + (sealant.harga_modal || 0) + '" /></div>' +
        '<div class="filter-field"><label>Satuan</label><select class="form-select price-input" data-sealant-field="uom">' + uomOptionsHtml(sealant.uom) + '</select></div>' +
        '</div></div>';
      this.bindSealantInputs();
    } else {
      const tier = State.priceCatalog.brand_tiers[key];
      if (!tier) { contentEl.innerHTML = '<p class="empty-state">Kategori tidak ditemukan.</p>'; return; }
      contentEl.innerHTML =
        '<div class="admin-form-row" style="align-items:flex-end;">' +
        '<div class="filter-field"><label>Nama Tier</label>' +
        '<input class="form-input price-input" data-tier-label="' + key + '" value="' + (tier.label || '') + '" /></div>' +
        '<button type="button" class="secondary-button ripple" id="btn-add-group-' + key + '">+ Tambah Grup Produk</button>' +
        '<button type="button" class="secondary-button ripple" id="btn-delete-tier-' + key + '" style="color:var(--color-danger);">Hapus Tier Ini</button>' +
        '</div>' +
        ((tier.groups || []).length === 0 ? '<p class="empty-state">Belum ada grup produk. Klik "+ Tambah Grup Produk" untuk mulai.</p>' : '') +
        (tier.groups || []).map((g, gi) => this.renderGroupTable(key, g, gi)).join('');
      this.bindTierLabelInput();

      document.getElementById('btn-add-group-' + key).addEventListener('click', () => this.addGroup(key));
      document.getElementById('btn-delete-tier-' + key).addEventListener('click', () => this.deleteTier(key));
    }

    this.bindItemInputs();
    this.bindDeleteButtons();
    this.bindAddButtons();
  },

  deleteTier(tierKey) {
    const tier = State.priceCatalog.brand_tiers[tierKey];
    const itemCount = (tier.groups || []).reduce((sum, g) => sum + (g.items || []).length, 0);
    const confirmMsg = 'Hapus tier "' + (tier.label || tierKey) + '"' +
      (itemCount > 0 ? ' beserta ' + itemCount + ' item harga di dalamnya' : '') + '? Ini tidak bisa dibatalkan setelah "Simpan Semua Perubahan" diklik.';
    if (!confirm(confirmMsg)) return;

    delete State.priceCatalog.brand_tiers[tierKey];
    State.priceCategory = Object.keys(State.priceCatalog.brand_tiers)[0] || 'glass';
    this.renderCategoryList();
    this.renderCategory();
    Snackbar.show('Tier dihapus dari tampilan — klik "Simpan Semua Perubahan" untuk permanen', 'success');
  },

  renderGroupTable(tierKey, group, groupIndex) {
    return '<div class="price-group-card">' +
      '<div class="price-group-header"><span class="price-group-code">' + (group.code || '') + '</span>' +
      '<input class="form-input price-input" data-group-name="' + tierKey + '|' + groupIndex + '" value="' + (group.name || '') + '" />' +
      '<button type="button" class="btn-row-delete" data-delete-group="' + tierKey + '|' + groupIndex + '" title="Hapus grup ini">✕ Hapus Grup</button>' +
      '</div>' +
      this.itemsTableHtml(group.items || [], tierKey, groupIndex) +
      '<button type="button" class="secondary-button ripple btn-add-item-row" data-add-item="' + tierKey + '|' + groupIndex + '">+ Tambah Item</button>' +
      '</div>';
  },

  renderFlatItemsTable(items, scope) {
    return '<div class="price-group-card">' +
      this.itemsTableHtml(items, scope, null) +
      '<button type="button" class="secondary-button ripple btn-add-item-row" data-add-item="' + scope + '|">+ Tambah Item</button>' +
      '</div>';
  },

  itemsTableHtml(items, scope, groupIndex) {
    const gi = groupIndex === null || groupIndex === undefined ? '' : groupIndex;
    return '<div class="table-scroll"><table class="data-table"><thead><tr>' +
      '<th class="col-name">Nama Item</th><th class="col-price">Harga Modal</th><th class="col-uom">Satuan</th><th class="col-action"></th>' +
      '</tr></thead><tbody>' +
      items.map((item, ii) => {
        const path = scope + '|' + gi + '|' + ii;
        return '<tr>' +
          '<td class="col-name"><input class="price-input" data-item-field="' + path + '|name" value="' + (item.name || '') + '" /></td>' +
          '<td class="col-price"><input type="number" class="price-input" data-item-field="' + path + '|harga_modal" value="' + (item.harga_modal || 0) + '" /></td>' +
          '<td class="col-uom"><select class="price-input" data-item-field="' + path + '|uom">' + uomOptionsHtml(item.uom) + '</select></td>' +
          '<td class="col-action"><button type="button" class="btn-row-delete" data-delete-item="' + path + '" title="Hapus item">✕</button></td>' +
          '</tr>';
      }).join('') +
      '</tbody></table></div>';
  },

  /** Ambil referensi array items sesuai scope ('glass'/'other'/tierKey) + groupIndex */
  getItemsArray(scope, groupIndex) {
    if (scope === 'glass') return State.priceCatalog.glass.items;
    if (scope === 'other') return State.priceCatalog.other.items;
    return State.priceCatalog.brand_tiers[scope].groups[groupIndex].items;
  },

  bindTierLabelInput() {
    document.querySelectorAll('[data-tier-label]').forEach((el) => {
      el.addEventListener('input', () => { State.priceCatalog.brand_tiers[el.dataset.tierLabel].label = el.value; });
    });
    document.querySelectorAll('[data-group-name]').forEach((el) => {
      el.addEventListener('input', () => {
        const [tierKey, gi] = el.dataset.groupName.split('|');
        State.priceCatalog.brand_tiers[tierKey].groups[Number(gi)].name = el.value;
      });
    });
  },

  bindSealantInputs() {
    document.querySelectorAll('[data-sealant-field]').forEach((el) => {
      el.addEventListener('input', () => {
        if (!State.priceCatalog.sealant) State.priceCatalog.sealant = {};
        const field = el.dataset.sealantField;
        State.priceCatalog.sealant[field] = field === 'harga_modal' ? Number(el.value) : el.value;
      });
    });
  },

  bindItemInputs() {
    document.querySelectorAll('[data-item-field]').forEach((el) => {
      el.addEventListener('input', () => {
        const [scope, gi, ii, field] = el.dataset.itemField.split('|');
        const groupIndex = gi === '' ? null : Number(gi);
        const arr = this.getItemsArray(scope, groupIndex);
        arr[Number(ii)][field] = field === 'harga_modal' ? Number(el.value) : el.value;
      });
    });
  },

  bindDeleteButtons() {
    document.querySelectorAll('[data-delete-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [scope, gi, ii] = btn.dataset.deleteItem.split('|');
        const groupIndex = gi === '' ? null : Number(gi);
        const arr = this.getItemsArray(scope, groupIndex);
        arr.splice(Number(ii), 1);
        this.renderCategory();
      });
    });
    document.querySelectorAll('[data-delete-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [tierKey, gi] = btn.dataset.deleteGroup.split('|');
        const group = State.priceCatalog.brand_tiers[tierKey].groups[Number(gi)];
        if (!confirm('Hapus grup "' + (group.name || '') + '" beserta ' + (group.items || []).length + ' item di dalamnya?')) return;
        State.priceCatalog.brand_tiers[tierKey].groups.splice(Number(gi), 1);
        this.renderCategory();
      });
    });
  },

  bindAddButtons() {
    document.querySelectorAll('[data-add-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [scope, gi] = btn.dataset.addItem.split('|');
        const groupIndex = gi === '' ? null : Number(gi);
        const arr = this.getItemsArray(scope, groupIndex);
        arr.push({ name: 'Item Baru', harga_modal: 0, uom: 'unit' });
        this.renderCategory();
      });
    });
  },

  /** Export katalog saat ini ke file Excel — 1 sheet per kategori */
  exportExcel() {
    if (!State.priceCatalog) { Snackbar.show('Data belum dimuat', 'error'); return; }
    const wb = XLSX.utils.book_new();
    const c = State.priceCatalog;

    const tierRows = [['Tier Key', 'Tier Label', 'Group Code', 'Group Name', 'Item Name', 'Harga Modal', 'Satuan']];
    Object.keys(c.brand_tiers || {}).forEach((tierKey) => {
      const tier = c.brand_tiers[tierKey];
      (tier.groups || []).forEach((g) => {
        (g.items || []).forEach((item) => {
          tierRows.push([tierKey, tier.label || '', g.code || '', g.name || '', item.name || '', item.harga_modal || 0, item.uom || '']);
        });
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tierRows), 'Brand Tiers');

    const glassRows = [['Item Name', 'Harga Modal', 'Satuan']];
    (c.glass.items || []).forEach((item) => glassRows.push([item.name || '', item.harga_modal || 0, item.uom || '']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(glassRows), 'Kaca');

    const otherRows = [['Item Name', 'Harga Modal', 'Satuan']];
    (c.other.items || []).forEach((item) => otherRows.push([item.name || '', item.harga_modal || 0, item.uom || '']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(otherRows), 'Lainnya');

    const sealant = c.sealant || { name: 'SEALANT', harga_modal: 0, uom: 'tube_estimated' };
    const sealantRows = [['Name', 'Harga Modal', 'Satuan'], [sealant.name || '', sealant.harga_modal || 0, sealant.uom || '']];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sealantRows), 'Sealant');

    XLSX.writeFile(wb, 'Katalog_Harga_' + State.businessId + '_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  },

  /** Baca file Excel hasil export (atau format sama) lalu bangun ulang State.priceCatalog di browser
      (belum tersimpan ke server sampai klik "Simpan Semua Perubahan") */
  importExcel(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const sheetToRows = (name) => {
          if (!wb.Sheets[name]) return [];
          return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }).slice(1);
        };

        const tierRows = sheetToRows('Brand Tiers');
        const newBrandTiers = {};
        tierRows.forEach((row) => {
          const [tierKey, tierLabel, groupCode, groupName, itemName, hargaModal, uom] = row;
          if (!tierKey || !itemName) return;
          if (!newBrandTiers[tierKey]) newBrandTiers[tierKey] = { label: tierLabel || tierKey, groups: [] };
          let group = newBrandTiers[tierKey].groups.find((g) => g.code === groupCode && g.name === groupName);
          if (!group) { group = { code: groupCode || '', name: groupName || '', items: [] }; newBrandTiers[tierKey].groups.push(group); }
          group.items.push({ name: itemName, harga_modal: Number(hargaModal) || 0, uom: uom || 'unit' });
        });

        const glassItems = sheetToRows('Kaca').filter((r) => r[0]).map((r) => ({ name: r[0], harga_modal: Number(r[1]) || 0, uom: r[2] || 'unit' }));
        const otherItems = sheetToRows('Lainnya').filter((r) => r[0]).map((r) => ({ name: r[0], harga_modal: Number(r[1]) || 0, uom: r[2] || 'unit' }));
        const sealantRows = sheetToRows('Sealant');
        const sealant = sealantRows.length > 0
          ? { name: sealantRows[0][0] || 'SEALANT', harga_modal: Number(sealantRows[0][1]) || 0, uom: sealantRows[0][2] || 'tube_estimated' }
          : State.priceCatalog.sealant;

        if (Object.keys(newBrandTiers).length === 0 && glassItems.length === 0 && otherItems.length === 0) {
          Snackbar.show('File Excel tidak sesuai format (sheet/kolom tidak ditemukan)', 'error');
          return;
        }

        State.priceCatalog = { brand_tiers: newBrandTiers, glass: { items: glassItems }, other: { items: otherItems }, sealant };
        State.priceCategory = Object.keys(newBrandTiers)[0] || 'glass';
        this.renderCategoryList();
        this.renderCategory();
        Snackbar.show('Data dari Excel dimuat — cek dulu, lalu klik "Simpan Semua Perubahan" untuk simpan ke server', 'success');
      } catch (err) {
        Snackbar.show('Gagal membaca file Excel: ' + err.message, 'error');
      } finally {
        document.getElementById('price-excel-file').value = '';
      }
    };
    reader.readAsArrayBuffer(file);
  },

  async save() {
    const btn = document.getElementById('btn-save-price-catalog');
    btn.disabled = true;
    btn.textContent = 'Menyimpan...';
    const result = await Api.call('updatePriceCatalog', Api.withBusiness({
      catalog: State.priceCatalog,
      change_summary: 'Diperbarui lewat Manager Dashboard oleh ' + (State.user.name || State.user.email)
    }));
    btn.disabled = false;
    btn.textContent = 'Simpan Semua Perubahan';

    if (!result.success) { Snackbar.show(result.message || 'Gagal menyimpan katalog harga', 'error'); return; }
    Snackbar.show('Katalog harga berhasil disimpan', 'success');
  }
};

/* ---- 19c. Kelola Akun User (super_admin) ---- */
const AdminUsers = {
  cachedUsers: [],

  init() {
    document.getElementById('btn-open-new-user-form').addEventListener('click', () => this.openForm());
    document.getElementById('btn-cancel-new-user').addEventListener('click', () => this.closeForm());
    document.getElementById('btn-submit-new-user').addEventListener('click', () => this.submitForm());
    document.getElementById('nu-role').addEventListener('change', () => this.applyEstimatorLock());
    document.getElementById('nu-biz-aluve').addEventListener('change', () => this.updatePrimaryVisibility());
    document.getElementById('nu-biz-gbp').addEventListener('change', () => this.updatePrimaryVisibility());
    this.applyEstimatorLock();
  },

  /** Pilihan "Bisnis Utama" cuma relevan & ditampilkan kalau DUA bisnis dicentang sekaligus */
  updatePrimaryVisibility() {
    const bothChecked = document.getElementById('nu-biz-aluve').checked && document.getElementById('nu-biz-gbp').checked;
    document.getElementById('nu-primary-row').hidden = !bothChecked;
  },

  /** Role "estimator" dikunci cuma boleh akses Aluve — cocokkan dengan guard rail di backend */
  applyEstimatorLock() {
    const isEstimator = document.getElementById('nu-role').value === 'estimator';
    const gbpCheckbox = document.getElementById('nu-biz-gbp');
    const aluveCheckbox = document.getElementById('nu-biz-aluve');
    document.getElementById('nu-biz-note').hidden = !isEstimator;
    gbpCheckbox.disabled = isEstimator;
    if (isEstimator) { gbpCheckbox.checked = false; aluveCheckbox.checked = true; }
    aluveCheckbox.disabled = isEstimator; // Aluve wajib nyala & tidak bisa dimatikan kalau estimator
    this.updatePrimaryVisibility();
  },

  openForm(user) {
    document.getElementById('new-user-form').hidden = false;
    document.getElementById('temp-password-display').hidden = true;

    if (user) {
      document.getElementById('nu-form-title').textContent = 'Edit Akun — ' + user.name;
      document.getElementById('nu-edit-uid').value = user.uid;
      document.getElementById('nu-name').value = user.name || '';
      document.getElementById('nu-email').value = user.email || '';
      document.getElementById('nu-email').disabled = true; // email tidak bisa diubah lewat form edit
      document.getElementById('nu-role').value = user.role || 'sales';
      document.getElementById('nu-sales-code').value = user.sales_code || '';
      const ids = user.business_ids || [user.business_id];
      document.getElementById('nu-biz-aluve').checked = ids.includes('aluve');
      document.getElementById('nu-biz-gbp').checked = ids.includes('gbp');
      // Bisnis utama = business_id (elemen pertama business_ids, sesuai kontrak backend)
      document.getElementById('nu-primary-gbp').checked = (user.business_id === 'gbp');
      document.getElementById('nu-primary-aluve').checked = (user.business_id !== 'gbp');
      document.getElementById('btn-submit-new-user').textContent = 'Simpan Perubahan';
    } else {
      document.getElementById('nu-form-title').textContent = 'Akun Baru';
      document.getElementById('nu-edit-uid').value = '';
      document.getElementById('nu-email').disabled = false;
      ['nu-name', 'nu-email', 'nu-sales-code'].forEach((id) => { document.getElementById(id).value = ''; });
      document.getElementById('nu-role').value = 'sales';
      document.getElementById('nu-biz-aluve').checked = false;
      document.getElementById('nu-biz-gbp').checked = false;
      document.getElementById('nu-primary-aluve').checked = true;
      document.getElementById('nu-primary-gbp').checked = false;
      document.getElementById('btn-submit-new-user').textContent = 'Buat Akun';
    }
    this.applyEstimatorLock();
    document.getElementById('new-user-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  closeForm() {
    document.getElementById('new-user-form').hidden = true;
  },

  getCheckedBusinessIds() {
    const aluveChecked = document.getElementById('nu-biz-aluve').checked;
    const gbpChecked = document.getElementById('nu-biz-gbp').checked;
    if (aluveChecked && gbpChecked) {
      // Dua-duanya dicentang — urutan (siapa jadi "utama"/business_id) ikut radio
      const gbpIsPrimary = document.getElementById('nu-primary-gbp').checked;
      return gbpIsPrimary ? ['gbp', 'aluve'] : ['aluve', 'gbp'];
    }
    const ids = [];
    if (aluveChecked) ids.push('aluve');
    if (gbpChecked) ids.push('gbp');
    return ids;
  },

  async load() {
    State.usersLoaded = true;
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = '<tr><td colspan="6"><p class="loading-text">Memuat...</p></td></tr>';

    const result = await Api.call('listUserAccounts', {});
    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat daftar akun', 'error'); return; }
    this.cachedUsers = result.data || [];
    this.render(this.cachedUsers);
  },

  render(users) {
    const tbody = document.getElementById('users-table-body');
    if (users.length === 0) { tbody.innerHTML = '<tr><td colspan="6"><p class="empty-state">Belum ada akun.</p></td></tr>'; return; }

    tbody.innerHTML = users.map((u) => {
      const statusClass = u.status === 'Aktif' ? 'badge-status-aktif' : 'badge-status-nonaktif';
      const toggleLabel = u.status === 'Aktif' ? 'Nonaktifkan' : 'Aktifkan';
      const bizIds = u.business_ids || [u.business_id];
      const bizLabel = bizIds.map((b) => b.toUpperCase()).join(' + ');
      const isSelf = u.uid === State.user.uid;
      return '<tr>' +
        '<td>' + u.name + '</td>' +
        '<td>' + u.email + '</td>' +
        '<td><span class="badge-role badge-role-' + u.role + '">' + u.role + '</span></td>' +
        '<td>' + bizLabel + '</td>' +
        '<td><span class="' + statusClass + '">' + u.status + '</span></td>' +
        '<td class="row-actions">' +
        '<button type="button" data-action="edit" data-uid="' + u.uid + '">Edit</button>' +
        (isSelf ? '' :
          '<button type="button" data-action="toggle" data-uid="' + u.uid + '" data-status="' + u.status + '">' + toggleLabel + '</button>' +
          '<button type="button" data-action="reset" data-uid="' + u.uid + '">Reset Password</button>' +
          '<button type="button" class="danger" data-action="delete" data-uid="' + u.uid + '" data-name="' + u.name + '">Hapus</button>'
        ) +
        '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('button[data-action="edit"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const user = this.cachedUsers.find((u) => u.uid === btn.dataset.uid);
        if (user) this.openForm(user);
      });
    });
    tbody.querySelectorAll('button[data-action="toggle"]').forEach((btn) => {
      btn.addEventListener('click', () => this.toggleStatus(btn.dataset.uid, btn.dataset.status));
    });
    tbody.querySelectorAll('button[data-action="reset"]').forEach((btn) => {
      btn.addEventListener('click', () => this.resetPassword(btn.dataset.uid));
    });
    tbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
      btn.addEventListener('click', () => this.deleteAccount(btn.dataset.uid, btn.dataset.name));
    });
  },

  async submitForm() {
    const editUid = document.getElementById('nu-edit-uid').value;
    const businessIds = this.getCheckedBusinessIds();
    if (businessIds.length === 0) { Snackbar.show('Pilih minimal 1 bisnis', 'error'); return; }

    if (editUid) {
      const payload = {
        uid: editUid,
        name: document.getElementById('nu-name').value.trim(),
        role: document.getElementById('nu-role').value,
        business_ids: businessIds,
        sales_code: document.getElementById('nu-sales-code').value.trim()
      };
      const result = await Api.call('updateUserRole', payload);
      if (!result.success) { Snackbar.show(result.message || 'Gagal menyimpan perubahan', 'error'); return; }
      Snackbar.show('Akun berhasil diperbarui', 'success');
      this.closeForm();
      this.load();
      return;
    }

    const payload = {
      name: document.getElementById('nu-name').value.trim(),
      email: document.getElementById('nu-email').value.trim(),
      role: document.getElementById('nu-role').value,
      business_id: businessIds[0],
      business_ids: businessIds,
      sales_code: document.getElementById('nu-sales-code').value.trim()
    };
    if (!payload.name || !payload.email) { Snackbar.show('Nama dan email wajib diisi', 'error'); return; }

    const result = await Api.call('createUserAccount', payload);
    if (!result.success) { Snackbar.show(result.message || 'Gagal membuat akun', 'error'); return; }

    this.closeForm();
    this.showTempPassword(result.data.email, result.data.temp_password);
    this.load();
  },

  async toggleStatus(uid, currentStatus) {
    const newStatus = currentStatus === 'Aktif' ? 'Nonaktif' : 'Aktif';
    const result = await Api.call('setUserStatus', { uid, status: newStatus });
    if (!result.success) { Snackbar.show(result.message || 'Gagal mengubah status', 'error'); return; }
    Snackbar.show('Status akun diperbarui', 'success');
    this.load();
  },

  async resetPassword(uid) {
    const result = await Api.call('resetUserPassword', { uid });
    if (!result.success) { Snackbar.show(result.message || 'Gagal reset password', 'error'); return; }
    this.showTempPassword(null, result.data.temp_password);
  },

  async deleteAccount(uid, name) {
    if (!confirm('Hapus akun "' + name + '" PERMANEN? Akun tidak akan bisa login lagi. Project/aktivitas yang pernah dibuat akun ini TIDAK ikut terhapus. Tindakan ini tidak bisa dibatalkan.')) return;

    const result = await Api.call('deleteUserAccount', { uid });
    if (!result.success) { Snackbar.show(result.message || 'Gagal menghapus akun', 'error'); return; }
    Snackbar.show('Akun berhasil dihapus', 'success');
    this.load();
  },

  showTempPassword(email, password) {
    const el = document.getElementById('temp-password-display');
    el.hidden = false;
    el.innerHTML = '<div class="temp-password-box">' +
      '<p>' + (email ? 'Akun <strong>' + email + '</strong> dibuat. ' : '') + 'Password sementara — salin & bagikan manual sekarang, tidak akan ditampilkan lagi:</p>' +
      '<span class="temp-password-value">' + password + '</span>' +
      '</div>';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
};

/* ---- 19c. Pengaturan Estimator (super_admin) ---- */
const AdminSettings = {
  init() {
    document.getElementById('btn-save-settings').addEventListener('click', () => this.save());
    document.getElementById('btn-upload-logo').addEventListener('click', () => document.getElementById('es-logo-file').click());
    document.getElementById('es-logo-file').addEventListener('change', (e) => this.uploadLogo(e.target.files[0]));
  },

  async load() {
    State.settingsLoaded = true;
    const result = await Api.call('readEstimatorSettings', Api.withBusiness({}));
    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat pengaturan', 'error'); return; }
    const d = result.data || {};
    document.getElementById('es-company-name').value = d.company_name || '';
    document.getElementById('es-company-phone').value = d.company_phone || '';
    document.getElementById('es-address').value = d.company_address || '';
    document.getElementById('es-bank-account').value = d.bank_account_info || '';
    document.getElementById('es-payment-terms').value = d.payment_terms || '';
    document.getElementById('es-validity-days').value = d.quotation_validity_days || 14;
    document.getElementById('es-terms').value = d.terms_and_conditions || '';
    this.renderLogoPreview(d.logo_url || '');
  },

  renderLogoPreview(url) {
    const img = document.getElementById('es-logo-preview');
    const placeholder = document.getElementById('es-logo-placeholder');
    if (url) {
      img.src = url; img.hidden = false; placeholder.hidden = true;
    } else {
      img.hidden = true; placeholder.hidden = false;
    }
  },

  async uploadLogo(file) {
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { Snackbar.show('Ukuran file maksimal 3MB', 'error'); return; }

    const btn = document.getElementById('btn-upload-logo');
    btn.disabled = true;
    btn.textContent = 'Mengunggah...';

    try {
      const base64 = await this.fileToBase64(file);
      const result = await Api.call('uploadEstimatorLogo', Api.withBusiness({ file_base64: base64, mime_type: file.type }));
      if (!result.success) throw new Error(result.message || 'Gagal upload logo');
      this.renderLogoPreview(result.data.logo_url);
      Snackbar.show('Logo berhasil diunggah', 'success');
    } catch (err) {
      Snackbar.show(err.message || 'Gagal upload logo', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Upload Logo';
      document.getElementById('es-logo-file').value = '';
    }
  },

  fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  async save() {
    const payload = Api.withBusiness({
      settings: {
        company_name: document.getElementById('es-company-name').value.trim(),
        company_phone: document.getElementById('es-company-phone').value.trim(),
        company_address: document.getElementById('es-address').value.trim(),
        bank_account_info: document.getElementById('es-bank-account').value.trim(),
        payment_terms: document.getElementById('es-payment-terms').value.trim(),
        quotation_validity_days: Number(document.getElementById('es-validity-days').value) || 14,
        terms_and_conditions: document.getElementById('es-terms').value.trim()
      }
    });
    const result = await Api.call('updateEstimatorSettings', payload);
    if (!result.success) { Snackbar.show(result.message || 'Gagal menyimpan pengaturan', 'error'); return; }
    Snackbar.show('Pengaturan berhasil disimpan', 'success');
  }
};

/* ============================================================
   19. DRAG-REPOSISI KARTU (Overview: KPI / Chart / Widget)
   ============================================================ */
const DragReorder = {
  STORAGE_PREFIX: 'mgr_card_order_',
  draggedEl: null,
  groups: {}, // groupKey -> { container, defaultOrder }

  /** Panggil sekali per grup saat init — mengembalikan urutan tersimpan (kalau ada) lalu memasang drag handler */
  init(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const groupKey = container.dataset.draggableGroup || containerId;

    const defaultOrder = Array.from(container.children).map((c) => c.dataset.cardId).filter(Boolean);
    this.groups[groupKey] = { container, defaultOrder };

    this.applyStoredOrder(container, groupKey);

    container.querySelectorAll(':scope > [draggable="true"]').forEach((card) => this.bindCard(card, container, groupKey));
  },

  applyStoredOrder(container, groupKey) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(this.STORAGE_PREFIX + groupKey)); } catch (e) { saved = null; }
    if (!saved || !Array.isArray(saved)) return;

    const byId = {};
    Array.from(container.children).forEach((c) => { if (c.dataset.cardId) byId[c.dataset.cardId] = c; });

    const ordered = [];
    saved.forEach((id) => { if (byId[id]) { ordered.push(byId[id]); delete byId[id]; } });
    // Kartu baru yang belum ada di urutan tersimpan (mis. ditambahkan setelah terakhir disusun) taruh di akhir
    Object.values(byId).forEach((c) => ordered.push(c));
    ordered.forEach((c) => container.appendChild(c));
  },

  saveOrder(container, groupKey) {
    const order = Array.from(container.children).map((c) => c.dataset.cardId).filter(Boolean);
    try { localStorage.setItem(this.STORAGE_PREFIX + groupKey, JSON.stringify(order)); } catch (e) { /* abaikan kalau storage penuh */ }
  },

  /** Kembalikan SEMUA grup (KPI/Chart/Widget) ke urutan bawaan & hapus penyimpanannya */
  resetAll() {
    Object.keys(this.groups).forEach((groupKey) => {
      const { container, defaultOrder } = this.groups[groupKey];
      try { localStorage.removeItem(this.STORAGE_PREFIX + groupKey); } catch (e) { /* abaikan */ }

      const byId = {};
      Array.from(container.children).forEach((c) => { if (c.dataset.cardId) byId[c.dataset.cardId] = c; });
      defaultOrder.forEach((id) => { if (byId[id]) container.appendChild(byId[id]); });
    });
  },

  bindCard(card, container, groupKey) {
    card.addEventListener('dragstart', () => {
      this.draggedEl = card;
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      this.draggedEl = null;
      this.saveOrder(container, groupKey);
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!this.draggedEl || this.draggedEl === card) return;
      const rect = card.getBoundingClientRect();
      const insertBefore = (e.clientX - rect.left) < rect.width / 2;
      container.insertBefore(this.draggedEl, insertBefore ? card : card.nextSibling);
    });
  }
};

/* ============================================================
   20. INIT
   ============================================================ */
function initApp() {
  Snackbar.init();
  ThemeToggle.init();
  TabNav.init();
  ExportManager.init();
  OverviewPage.initGranularityToggle();
  ExplorerPage.init();
  DetailModal.init();
  LogPage.init();
  BusinessSwitcher.init();
  DragReorder.init('kpi-grid');
  DragReorder.init('chart-grid');
  DragReorder.init('widget-grid');
  document.getElementById('btn-reset-card-order').addEventListener('click', () => {
    DragReorder.resetAll();
    Snackbar.show('Susunan kartu dikembalikan ke default', 'success');
  });

  document.getElementById('tab-btn-admin').hidden = false; // login sudah memastikan role manager/super_admin

  document.getElementById('header-subtitle').textContent =
    'Halo, ' + State.user.name + ' — data real-time dari seluruh tim sales';

  const headerLogo = document.getElementById('header-logo');
  headerLogo.addEventListener('error', () => { headerLogo.style.display = 'none'; });

  FilterBar.init().then(() => { OverviewPage.load(); });
}

document.addEventListener('DOMContentLoaded', () => { Login.init(); });
