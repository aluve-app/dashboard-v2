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
      if (rememberChecked) localStorage.setItem(this.REMEMBER_KEY, email);
      else localStorage.removeItem(this.REMEMBER_KEY);

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
    document.getElementById('app').hidden = true;
    document.getElementById('view-login').hidden = false;
    document.getElementById('login-email').value = '';
    document.getElementById('login-password').value = '';
  }
};

/* ============================================================
   9. BUSINESS SWITCHER (khusus super_admin)
   ============================================================ */
const BusinessSwitcher = {
  init() {
    const wrap = document.getElementById('business-switcher');
    if (State.user.role !== 'super_admin') { wrap.hidden = true; return; }
    wrap.hidden = false;
    wrap.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.business === State.businessId);
      btn.addEventListener('click', () => this.switchTo(btn.dataset.business));
    });
  },
  switchTo(businessId) {
    if (businessId === State.businessId) return;
    State.businessId = businessId;
    document.querySelectorAll('#business-switcher button').forEach((b) => b.classList.toggle('active', b.dataset.business === businessId));

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

    tbody.innerHTML = projects.map((p) => {
      const valueText = p.estimated_value ? Utils.formatCurrency(p.estimated_value) : '-';
      const leadSource = p.lead_source || '-';
      return '<tr data-project-id="' + p.project_id + '" data-project-name="' + p.project_name + '" data-project-stage="' + p.pipeline_stage + '" data-project-value="' + valueText + '" data-project-address="' + (p.location_address || '-') + '" data-project-lead-source="' + leadSource + '">' +
        '<td>' + p.project_name + '</td>' +
        '<td>' + p.sales_name + '</td>' +
        '<td>' + p.pipeline_stage + '</td>' +
        '<td>' + leadSource + '</td>' +
        '<td>' + valueText + '</td>' +
        '<td>' + (p.location_address || '-') + '</td>' +
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
    document.getElementById('admin-subnav-users').hidden = !isSuperAdmin;
    document.getElementById('admin-subnav-settings').hidden = !isSuperAdmin;

    AdminLookup.init();
    if (isSuperAdmin) { AdminUsers.init(); AdminSettings.init(); }
  },
  goTo(panel) {
    document.querySelectorAll('.admin-subnav button').forEach((b) => b.classList.toggle('active', b.dataset.adminPanel === panel));
    document.querySelectorAll('.admin-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('admin-panel-' + panel).classList.add('active');
    if (panel === 'users' && !State.usersLoaded) AdminUsers.load();
    if (panel === 'settings' && !State.settingsLoaded) AdminSettings.load();
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
    el.innerHTML = values.length === 0
      ? '<p class="empty-state" style="padding: var(--space-sm) 0;">Belum ada pilihan untuk kategori ini.</p>'
      : values.map((v) =>
          '<span class="lookup-chip">' + v + '<button type="button" data-value="' + v + '">✕</button></span>'
        ).join('');
    el.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => this.removeValue(btn.dataset.value));
    });
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

/* ---- 19b. Kelola Akun User (super_admin) ---- */
const AdminUsers = {
  init() {
    document.getElementById('btn-open-new-user-form').addEventListener('click', () => {
      document.getElementById('new-user-form').hidden = false;
    });
    document.getElementById('btn-cancel-new-user').addEventListener('click', () => {
      document.getElementById('new-user-form').hidden = true;
    });
    document.getElementById('btn-submit-new-user').addEventListener('click', () => this.createUser());
  },

  async load() {
    State.usersLoaded = true;
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = '<tr><td colspan="6"><p class="loading-text">Memuat...</p></td></tr>';

    const result = await Api.call('listUserAccounts', {});
    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat daftar akun', 'error'); return; }
    this.render(result.data || []);
  },

  render(users) {
    const tbody = document.getElementById('users-table-body');
    if (users.length === 0) { tbody.innerHTML = '<tr><td colspan="6"><p class="empty-state">Belum ada akun.</p></td></tr>'; return; }

    tbody.innerHTML = users.map((u) => {
      const statusClass = u.status === 'Aktif' ? 'badge-status-aktif' : 'badge-status-nonaktif';
      const toggleLabel = u.status === 'Aktif' ? 'Nonaktifkan' : 'Aktifkan';
      return '<tr>' +
        '<td>' + u.name + '</td>' +
        '<td>' + u.email + '</td>' +
        '<td><span class="badge-role badge-role-' + u.role + '">' + u.role + '</span></td>' +
        '<td>' + (u.business_id || '-').toUpperCase() + '</td>' +
        '<td><span class="' + statusClass + '">' + u.status + '</span></td>' +
        '<td class="row-actions">' +
        '<button type="button" data-action="toggle" data-uid="' + u.uid + '" data-status="' + u.status + '">' + toggleLabel + '</button>' +
        '<button type="button" data-action="reset" data-uid="' + u.uid + '">Reset Password</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('button[data-action="toggle"]').forEach((btn) => {
      btn.addEventListener('click', () => this.toggleStatus(btn.dataset.uid, btn.dataset.status));
    });
    tbody.querySelectorAll('button[data-action="reset"]').forEach((btn) => {
      btn.addEventListener('click', () => this.resetPassword(btn.dataset.uid));
    });
  },

  async createUser() {
    const payload = {
      name: document.getElementById('nu-name').value.trim(),
      email: document.getElementById('nu-email').value.trim(),
      role: document.getElementById('nu-role').value,
      business_id: document.getElementById('nu-business').value,
      sales_code: document.getElementById('nu-sales-code').value.trim()
    };
    if (!payload.name || !payload.email) { Snackbar.show('Nama dan email wajib diisi', 'error'); return; }

    const result = await Api.call('createUserAccount', payload);
    if (!result.success) { Snackbar.show(result.message || 'Gagal membuat akun', 'error'); return; }

    document.getElementById('new-user-form').hidden = true;
    ['nu-name', 'nu-email', 'nu-sales-code'].forEach((id) => { document.getElementById(id).value = ''; });

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
  },

  async load() {
    State.settingsLoaded = true;
    const result = await Api.call('readEstimatorSettings', Api.withBusiness({}));
    if (!result.success) { Snackbar.show(result.message || 'Gagal memuat pengaturan', 'error'); return; }
    const d = result.data || {};
    document.getElementById('es-company-name').value = d.company_name || '';
    document.getElementById('es-address').value = d.address || '';
    document.getElementById('es-bank-account').value = d.bank_account || '';
    document.getElementById('es-payment-terms').value = d.payment_terms || '';
    document.getElementById('es-terms').value = d.terms_and_conditions || '';
  },

  async save() {
    const payload = Api.withBusiness({
      company_name: document.getElementById('es-company-name').value.trim(),
      address: document.getElementById('es-address').value.trim(),
      bank_account: document.getElementById('es-bank-account').value.trim(),
      payment_terms: document.getElementById('es-payment-terms').value.trim(),
      terms_and_conditions: document.getElementById('es-terms').value.trim()
    });
    const result = await Api.call('updateEstimatorSettings', payload);
    if (!result.success) { Snackbar.show(result.message || 'Gagal menyimpan pengaturan', 'error'); return; }
    Snackbar.show('Pengaturan berhasil disimpan', 'success');
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

  document.getElementById('tab-btn-admin').hidden = false; // login sudah memastikan role manager/super_admin

  document.getElementById('header-subtitle').textContent =
    'Halo, ' + State.user.name + ' — data real-time dari seluruh tim sales';

  const headerLogo = document.getElementById('header-logo');
  headerLogo.addEventListener('error', () => { headerLogo.style.display = 'none'; });

  FilterBar.init().then(() => { OverviewPage.load(); });
}

document.addEventListener('DOMContentLoaded', () => { Login.init(); });
