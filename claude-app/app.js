/*
 * app.js — telas, formulários e armazenamento do Vagalume.
 *
 * Vagalume é uma adaptação do Firefly III (https://github.com/firefly-iii/firefly-iii)
 * para rodar como página do Claude, sem servidor próprio.
 * Firefly III: Copyright (c) James Cole <james@firefly-iii.org> e colaboradores.
 * Modificações: Copyright (c) 2026 rcbortolini.
 *
 * Licenciado sob a GNU Affero General Public License, versão 3 ou posterior.
 * Veja <https://www.gnu.org/licenses/agpl-3.0.html>.
 */
(function () {
    'use strict';

    const C = window.FFCore;
    const SOURCE_URL = 'https://github.com/rcbortolini/firefly-iii/tree/claude/vagalume/claude-app';
    const FIREFLY_URL = 'https://github.com/firefly-iii/firefly-iii';
    const DOCS = ['accounts', 'categories', 'budgets', 'bills', 'recurrences', 'piggies', 'rules', 'settings'];
    const TAB_ID = C.newId();

    const $ = (s, el) => (el || document).querySelector(s);
    const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const today = () => C.todayISO();
    const nowISO = () => new Date().toISOString();
    const byName = (a, b) => String(a.name || a.title || '').localeCompare(String(b.name || b.title || ''), 'pt-BR');

    // ------------------------------------------------------------------ estado

    let S = C.emptyState();
    const ui = {
        stack: [{view: 'painel'}],
        month: C.monthKey(today()),
        txFilter: 'todos',
        search: '',
        accTab: 'minhas',
        reportMode: 'mes',
        reportMonth: C.monthKey(today()),
        reportYear: +today().slice(0, 4),
    };
    const store = {
        mode: 'carregando', // carregando | db | demo
        coll: null,
        dirty: new Set(),
        running: new Set(),
        recurrencesDone: false,
        revoked: false,
        downloads: undefined,
    };

    // ---------------------------------------------------------- armazenamento
    // Dados ficam em data/users/<id>/, área privada de cada pessoa no banco do Claude.
    // Um documento por tipo de entidade e um documento por mês de lançamentos (tx-AAAA-MM).

    const busy = (name) => store.dirty.has(name) || store.running.has(name);

    function persist(...names) {
        for (const n of new Set(names.filter(Boolean))) {
            if (store.mode !== 'db') {
                continue;
            }
            store.dirty.add(n);
            if (!store.running.has(n)) {
                runWriter(n);
            }
        }
    }

    async function runWriter(name) {
        store.running.add(name);
        try {
            while (store.dirty.has(name)) {
                store.dirty.delete(name);
                await writeDoc(name);
            }
        } finally {
            store.running.delete(name);
        }
    }

    function bodyFor(name) {
        if (name.startsWith('tx-')) {
            const mk = name.slice(3);
            const items = {};
            for (const t of Object.values(S.tx)) {
                if (C.monthKey(t.date) === mk) {
                    items[t.id] = t;
                }
            }
            return Object.keys(items).length ? {items, updatedAt: nowISO()} : null;
        }
        return {items: S[name] || {}, updatedAt: nowISO()};
    }

    async function writeDoc(name) {
        const ref = store.coll.doc(name);
        const body = bodyFor(name);
        if (body && JSON.stringify(body).length > 240000) {
            toast('Este mês está quase no limite de tamanho do banco de dados. Exporte um backup.');
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                if (body === null) {
                    await ref.delete();
                } else {
                    await ref.set(body);
                }
                return;
            } catch (e) {
                if (e && e.code === 'unavailable' && attempt === 0) {
                    await sleep(300 + Math.random() * 600);
                    continue;
                }
                storeError(e);
                return;
            }
        }
    }

    function storeError(e) {
        const code = e && e.code;
        if (code === 'quota_exceeded') {
            toast('O espaço do banco de dados acabou. Exporte um backup e apague meses antigos.');
        } else if (code === 'revoked') {
            store.revoked = true;
            render();
        } else {
            toast('Não foi possível salvar agora. Verifique a conexão e tente de novo.');
        }
    }

    function monthsInState() {
        const set = new Set();
        for (const t of Object.values(S.tx)) {
            set.add('tx-' + C.monthKey(t.date));
        }
        return set;
    }

    function replaceMonth(mk, items) {
        for (const t of Object.values(S.tx)) {
            if (C.monthKey(t.date) === mk) {
                delete S.tx[t.id];
            }
        }
        for (const t of Object.values(items)) {
            S.tx[t.id] = t;
        }
    }

    function onSnap(snap) {
        const seen = new Set();
        const definitive = !snap.metadata.fromCache;
        for (const d of snap.docs) {
            const name = d.id;
            seen.add(name);
            if (busy(name)) {
                continue;
            }
            const body = clone(d.data() || {});
            if (name.startsWith('tx-')) {
                replaceMonth(name.slice(3), body.items || {});
            } else if (DOCS.includes(name)) {
                S[name] = body.items || {};
            }
        }
        if (definitive) {
            for (const name of DOCS) {
                if (!seen.has(name) && !busy(name)) {
                    S[name] = {};
                }
            }
            for (const name of monthsInState()) {
                if (!seen.has(name) && !busy(name)) {
                    replaceMonth(name.slice(3), {});
                }
            }
        }
        // Um primeiro retrato vazio vindo do cache não basta para mostrar a tela de boas-vindas.
        if (definitive || snap.docs.length) {
            store.mode = 'db';
        }
        if (definitive && !store.recurrencesDone) {
            store.recurrencesDone = true;
            runRecurrences();
        }
        render();
    }

    function onSnapError(e) {
        if (e && e.code === 'unavailable') {
            setTimeout(subscribe, 3000);
            return;
        }
        store.revoked = true;
        render();
    }

    function subscribe() {
        store.coll.onSnapshot(onSnap, onSnapError);
    }

    async function boot() {
        document.documentElement.lang = 'pt-BR';
        $$('[data-ico]').forEach((el) => {
            el.insertAdjacentHTML('afterbegin', ICON[el.dataset.ico]);
        });
        render();
        let db = null;
        let user = null;
        let uid = null;
        try {
            if (window.claude && window.claude.use) {
                [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
                if (db && user) {
                    uid = await user.id();
                }
            }
        } catch (e) {
            db = null;
        }
        if (!db || !uid) {
            startDemo();
            return;
        }
        store.coll = db.collection('data/users/' + uid);
        subscribe();
    }

    function startDemo() {
        store.mode = 'demo';
        S = demoState();
        store.recurrencesDone = true;
        runRecurrences();
        render();
    }

    // ------------------------------------------------------------- mutações

    function ensureAccount(name, kind, touched) {
        const n = String(name || '').trim() || 'Diversos';
        const grupo = C.ACCOUNT_KINDS[kind].grupo;
        const found = C.findAccountByName(S, n, grupo);
        if (found) {
            return found.id;
        }
        const a = {id: C.newId(), name: n, kind, active: true, createdAt: nowISO()};
        S.accounts[a.id] = a;
        touched.add('accounts');
        return a.id;
    }

    function ensureCategory(name, touched) {
        const n = String(name || '').trim();
        if (!n) {
            return null;
        }
        const found = Object.values(S.categories).find((c) => c.name.toLocaleLowerCase('pt-BR') === n.toLocaleLowerCase('pt-BR'));
        if (found) {
            return found.id;
        }
        const c = {id: C.newId(), name: n, createdAt: nowISO()};
        S.categories[c.id] = c;
        touched.add('categories');
        return c.id;
    }

    function ruleCtx(touched) {
        return {
            accName: (id) => (S.accounts[id] ? S.accounts[id].name : ''),
            ensureAccount: (name, kind) => ensureAccount(name, kind, touched),
        };
    }

    function withRules(t, event, touched) {
        return C.normalizeTx(S, C.applyRules(S, t, ruleCtx(touched), {event}).tx);
    }

    function putTx(t, prev, touched) {
        S.tx[t.id] = t;
        touched.add('tx-' + C.monthKey(t.date));
        if (prev && C.monthKey(prev.date) !== C.monthKey(t.date)) {
            touched.add('tx-' + C.monthKey(prev.date));
        }
    }

    function removeTx(ids, touched) {
        for (const id of ids) {
            const t = S.tx[id];
            if (t) {
                delete S.tx[id];
                touched.add('tx-' + C.monthKey(t.date));
            }
        }
    }

    /** Remove referências a uma entidade apagada (ex.: categoria) dos lançamentos. */
    function unlinkTx(field, id, touched) {
        for (const t of Object.values(S.tx)) {
            if (t[field] === id) {
                S.tx[t.id] = Object.assign({}, t, {[field]: null});
                touched.add('tx-' + C.monthKey(t.date));
            }
        }
    }

    function commit(touched) {
        persist(...touched);
        render();
    }

    async function runRecurrences() {
        if (!Object.keys(S.recurrences).length || !C.dueRecurrences(S, today()).length) {
            return;
        }
        if (store.mode === 'db') {
            try {
                const ref = store.coll.doc('recurrences');
                const lease = await ref.acquire({holder: TAB_ID, ttlMs: 15000});
                if (!lease.acquired) {
                    return;
                }
                // Outro aparelho pode ter criado os lançamentos há pouco: adota o lastCreated mais recente.
                const fresh = await ref.get();
                const items = fresh.exists ? fresh.data().items || {} : {};
                for (const id of Object.keys(S.recurrences)) {
                    const f = items[id];
                    if (f && f.lastCreated && (!S.recurrences[id].lastCreated || f.lastCreated > S.recurrences[id].lastCreated)) {
                        S.recurrences[id] = Object.assign({}, S.recurrences[id], {lastCreated: f.lastCreated});
                    }
                }
            } catch (e) {
                return;
            }
        }
        const due = C.dueRecurrences(S, today());
        const touched = new Set(['recurrences']);
        let n = 0;
        for (const {rec, dates} of due) {
            for (const d of dates) {
                let t = C.normalizeTx(S, C.recurrenceTx(rec, d));
                if (rec.applyRules) {
                    t = withRules(t, 'criar', touched);
                }
                if (!C.validateTx(S, t)) {
                    putTx(t, null, touched);
                    n++;
                }
            }
            S.recurrences[rec.id] = Object.assign({}, rec, {lastCreated: dates[dates.length - 1]});
        }
        commit(touched);
        if (n) {
            toast(n === 1 ? '1 lançamento recorrente foi criado.' : n + ' lançamentos recorrentes foram criados.');
        }
    }

    // --------------------------------------------------------------- ícones

    const svg = (body, cls) => `<svg class="${cls || 'ico'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    const ICON = {
        painel: svg('<rect x="3" y="3" width="7.5" height="9" rx="1.8"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.8"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.8"/><rect x="3" y="15" width="7.5" height="6" rx="1.8"/>'),
        lancamentos: svg('<path d="M9 6.5h11.5M9 12h11.5M9 17.5h11.5"/><circle cx="4.5" cy="6.5" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="17.5" r="1.2"/>'),
        contas: svg('<rect x="2.5" y="5.5" width="19" height="14" rx="2.6"/><path d="M2.5 10h19M6.5 15.5h4"/>'),
        mais: svg('<circle cx="5.5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.5" cy="12" r="1.5"/>'),
        plus: svg('<path d="M12 5v14M5 12h14"/>'),
        chevron: svg('<path d="M9.5 6l6 6-6 6"/>', 'chev'),
        back: svg('<path d="M15 5.5L8.5 12l6.5 6.5"/>'),
        edit: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>'),
        search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
        retirada: svg('<path d="M7 17L17 7M9 7h8v8"/>'),
        deposito: svg('<path d="M17 7L7 17M15 17H7V9"/>'),
        transferencia: svg('<path d="M4 9h14l-3.5-3.5M20 15H6l3.5 3.5"/>'),
        orcamentos: svg('<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12z"/><path d="M15 3.8A8.5 8.5 0 0 1 20.2 9H15z"/>'),
        categorias: svg('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
        tags: svg('<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.4 6.4a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.4"/>'),
        bills: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.4"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14.5h3"/>'),
        recorrencias: svg('<path d="M4 11a8 8 0 0 1 14-4.5L20 8.5M20 4v4.5h-4.5M20 13a8 8 0 0 1-14 4.5L4 15.5M4 20v-4.5h4.5"/>'),
        cofrinhos: svg('<path d="M5 11.5c0-3.3 3.1-6 7-6s7 2.7 7 6c0 2-1.1 3.7-2.8 4.8V19h-2.7v-1.6a9 9 0 0 1-3 0V19H7.8v-2.7C6 15.2 5 13.5 5 11.5z"/><path d="M19 10.5h1.5v3H19M10 5.8l-1.2-2.3"/><circle cx="15" cy="10.5" r=".6" fill="currentColor"/>'),
        regras: svg('<path d="M4 5h16l-6 7.5V19l-4 1.5v-8z"/>'),
        relatorios: svg('<path d="M4 20h16"/><rect x="5.5" y="11" width="3" height="6.5" rx="1"/><rect x="10.5" y="6" width="3" height="11.5" rx="1"/><rect x="15.5" y="13" width="3" height="4.5" rx="1"/>'),
        backup: svg('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M4 16.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-2.5"/>'),
        sobre: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>'),
    };

    // ----------------------------------------------------------- componentes

    const money = (c) => esc(C.fmtMoney(c));
    const MINUS = '−';

    function signedMoney(cents) {
        if (cents < 0) {
            return MINUS + esc(C.fmtMoney(-cents));
        }
        return esc(C.fmtMoney(cents));
    }

    function amountClass(cents) {
        return cents < 0 ? 'neg' : cents > 0 ? 'pos' : '';
    }

    function accName(id) {
        return S.accounts[id] ? S.accounts[id].name : '(conta apagada)';
    }

    function ownAccounts(includeInactive) {
        return Object.values(S.accounts).filter((a) => C.isOwn(a) && (includeInactive || a.active !== false)).sort(byName);
    }

    function counterparties(grupo) {
        return Object.values(S.accounts).filter((a) => C.groupOf(a) === grupo).sort(byName);
    }

    function monthNav(key, value, label) {
        return `<div class="periodnav" role="group" aria-label="Período">
            <button type="button" class="icon-btn" data-act="periodo" data-key="${key}" data-d="-1" aria-label="Período anterior">${ICON.back}</button>
            <button type="button" class="period-label" data-act="periodo-hoje" data-key="${key}">${esc(label || C.fmtMonth(value))}</button>
            <button type="button" class="icon-btn flip" data-act="periodo" data-key="${key}" data-d="1" aria-label="Próximo período">${ICON.back}</button>
        </div>`;
    }

    function meter(spent, limit) {
        if (!limit) {
            return '';
        }
        const pct = spent / limit;
        const state = pct > 1 ? 'over' : pct >= 0.85 ? 'warn' : 'ok';
        return `<div class="meter ${state}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(pct, 1) * 100)}"><div style="width:${Math.min(100, pct * 100).toFixed(1)}%"></div></div>`;
    }

    function section(title, body, link) {
        return `<section class="sec"><div class="sec-head"><h2>${esc(title)}</h2>${link || ''}</div>${body}</section>`;
    }

    const seeAll = (go, label) => `<button type="button" class="link" data-go="${go}">${esc(label || 'Ver tudo')}</button>`;

    function empty(text, btn) {
        return `<div class="empty"><p>${esc(text)}</p>${btn || ''}</div>`;
    }

    function rowLink(go, id, title, sub, right, extra) {
        return `<button type="button" class="row" data-go="${go}" ${id ? `data-id="${esc(id)}"` : ''}>
            ${extra || ''}<span class="row-main"><span class="row-title">${title}</span>${sub ? `<span class="row-sub">${sub}</span>` : ''}</span>
            ${right ? `<span class="row-right">${right}</span>` : ''}${ICON.chevron}</button>`;
    }

    /** Linha de lançamento. Com `accId`, o sinal é do ponto de vista dessa conta. */
    function txRow(t, accId) {
        let sign = t.type === 'retirada' ? -1 : t.type === 'deposito' ? 1 : 0;
        if (accId && C.isOwn(S.accounts[accId])) {
            sign = t.dest === accId ? 1 : -1;
        }
        const cat = t.categoryId && S.categories[t.categoryId];
        const route = `${esc(accName(t.source))} → ${esc(accName(t.dest))}`;
        const meta = [cat ? esc(cat.name) : null].concat((t.tags || []).map((x) => '#' + esc(x))).filter(Boolean).join(' · ');
        return `<button type="button" class="row tx" data-act="editar-lancamento" data-id="${esc(t.id)}">
            <span class="tx-ico ${t.type}" title="${esc(C.TX_TYPES[t.type] ? C.TX_TYPES[t.type].label : '')}">${ICON[t.type] || ''}</span>
            <span class="row-main"><span class="row-title">${esc(t.description)}</span>
            <span class="row-sub">${route}${meta ? ' · ' + meta : ''}</span></span>
            <span class="amount ${sign < 0 ? 'neg' : sign > 0 ? 'pos' : ''}">${sign < 0 ? MINUS : sign > 0 ? '+' : ''}${money(t.amount)}</span></button>`;
    }

    function txList(list, accId, limit) {
        if (!list.length) {
            return empty('Nenhum lançamento neste período.');
        }
        const shown = limit ? list.slice(0, limit) : list;
        let html = '';
        let day = null;
        for (const t of shown) {
            if (!limit && t.date !== day) {
                if (day !== null) {
                    html += '</div>';
                }
                day = t.date;
                html += `<h3 class="day">${esc(C.fmtDate(t.date, 'dia'))}</h3><div class="group">`;
            }
            html += txRow(t, accId);
        }
        if (!limit && day !== null) {
            html += '</div>';
        }
        if (limit) {
            html = `<div class="group">${html}</div>`;
        }
        if (!limit && list.length > shown.length) {
            html += `<p class="muted center">Mostrando ${shown.length} de ${list.length}.</p>`;
        }
        return html;
    }

    function chip(status) {
        const map = {
            paga: ['Paga', 'good'], pendente: ['A pagar', 'info'], atrasada: ['Atrasada', 'bad'],
            sem_vencimento: ['Sem vencimento no mês', 'muted'], inativa: ['Inativa', 'muted'],
        };
        const [label, cls] = map[status] || [status, 'muted'];
        return `<span class="chip ${cls}">${label}</span>`;
    }

    function hbars(entries, nameOf, go) {
        if (!entries.length) {
            return empty('Nada para mostrar neste período.');
        }
        const max = Math.max(...entries.map((e) => e.value));
        return `<div class="group pad">${entries.map((e) => {
            const name = nameOf(e);
            const inner = `<span class="hbar-top"><span class="hbar-name">${esc(name)}</span><span class="hbar-val">${money(e.value)}</span></span>
                <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(1.5, e.value / max * 100).toFixed(1)}%"></span></span>`;
            const canGo = go && e.id && e.id !== '__outros';
            return canGo ? `<button type="button" class="hbar" data-go="${go}" data-id="${esc(e.id)}">${inner}</button>` : `<div class="hbar">${inner}</div>`;
        }).join('')}</div>`;
    }

    function tiles(items) {
        return `<div class="tiles">${items.map((i) => `<div class="tile"><span class="tile-label">${esc(i.label)}</span>
            <span class="tile-value ${i.cls || ''}">${i.value}</span>${i.sub ? `<span class="tile-sub">${i.sub}</span>` : ''}</div>`).join('')}</div>`;
    }

    // ------------------------------------------------------------- gráficos

    const charts = new Map();
    let chartSeq = 0;

    function chart(spec) {
        const id = 'c' + (++chartSeq);
        charts.set(id, spec);
        return `<div class="chart" data-chart="${id}" style="height:${spec.height || 180}px" role="img" aria-label="${esc(spec.label || '')}"></div>`;
    }

    function niceStep(range, ticks) {
        const raw = range / ticks;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const n = raw / mag;
        return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    }

    function scaleY(min, max, ticks) {
        if (min === max) {
            min -= 10000;
            max += 10000;
        }
        const step = niceStep(max - min, ticks);
        const lo = Math.floor(min / step) * step;
        const hi = Math.ceil(max / step) * step;
        const list = [];
        for (let v = lo; v <= hi + step / 2; v += step) {
            list.push(v);
        }
        return {lo, hi, list};
    }

    function drawCharts(root) {
        $$('[data-chart]', root).forEach((el) => {
            const spec = charts.get(el.dataset.chart);
            if (spec) {
                (spec.kind === 'colunas' ? drawColumns : drawLine)(el, spec);
            }
        });
    }

    function tooltipEl(el) {
        let tip = $('.tip', el);
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'tip';
            tip.hidden = true;
            el.appendChild(tip);
        }
        return tip;
    }

    function placeTip(el, tip, x, html) {
        tip.innerHTML = html;
        tip.hidden = false;
        const w = tip.offsetWidth;
        const left = Math.max(0, Math.min(el.clientWidth - w, x - w / 2));
        tip.style.left = left + 'px';
    }

    /** Linha única com área: spec {values, labels, tips, height, label}. */
    function drawLine(el, spec) {
        const W = Math.max(240, el.clientWidth);
        const H = spec.height || 180;
        const pad = {l: 4, r: 66, t: 12, b: 24};
        const vals = spec.values;
        const n = vals.length;
        const sc = scaleY(Math.min(...vals), Math.max(...vals), 3);
        const x = (i) => pad.l + (n === 1 ? (W - pad.l - pad.r) / 2 : i * (W - pad.l - pad.r) / (n - 1));
        const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - sc.lo) / (sc.hi - sc.lo));
        let grid = '';
        for (const v of sc.list) {
            grid += `<line class="grid" x1="0" x2="${W - pad.r + 6}" y1="${y(v)}" y2="${y(v)}"/>
                <text class="tick" x="${W - 2}" y="${y(v) + 4}" text-anchor="end">${esc(C.fmtMoneyCompact(v))}</text>`;
        }
        const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
        const line = 'M' + pts.join('L');
        const area = `${line}L${x(n - 1).toFixed(1)},${H - pad.b}L${x(0).toFixed(1)},${H - pad.b}Z`;
        const xl = [];
        const every = Math.max(1, Math.ceil(n / 5));
        for (let i = 0; i < n; i += every) {
            xl.push(i);
        }
        let xlab = '';
        for (const i of xl) {
            const anchor = i === 0 ? 'start' : 'middle';
            xlab += `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="${anchor}">${esc(spec.labels[i])}</text>`;
        }
        el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}
            <path class="area" d="${area}"/><path class="line" d="${line}"/>
            <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
            <circle class="dot" r="4" cx="${x(n - 1)}" cy="${y(vals[n - 1])}"/>${xlab}
            <rect class="hit" x="0" y="0" width="${W}" height="${H}"/></svg>`;
        const s = $('svg', el);
        const cross = $('.cross', s);
        const dot = $('.dot', s);
        const tip = tooltipEl(el);
        const show = (ev) => {
            const r = s.getBoundingClientRect();
            const i = Math.max(0, Math.min(n - 1, Math.round((ev.clientX - r.left - pad.l) / ((W - pad.l - pad.r) / Math.max(1, n - 1)))));
            cross.setAttribute('x1', x(i));
            cross.setAttribute('x2', x(i));
            cross.setAttribute('visibility', 'visible');
            dot.setAttribute('cx', x(i));
            dot.setAttribute('cy', y(vals[i]));
            placeTip(el, tip, x(i), `<b>${esc(C.fmtMoney(vals[i]))}</b><span>${esc(spec.tips[i])}</span>`);
        };
        const hide = () => {
            cross.setAttribute('visibility', 'hidden');
            dot.setAttribute('cx', x(n - 1));
            dot.setAttribute('cy', y(vals[n - 1]));
            tip.hidden = true;
        };
        s.addEventListener('pointermove', show);
        s.addEventListener('pointerdown', show);
        s.addEventListener('pointerleave', hide);
    }

    function colPath(x, y, w, h) {
        const r = Math.min(4, h, w / 2);
        const b = y + h;
        return `M${x},${b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${b}Z`;
    }

    /** Colunas agrupadas a partir do zero: spec {labels, series:[{name, cls, values}], tips}. */
    function drawColumns(el, spec) {
        const W = Math.max(240, el.clientWidth);
        const H = spec.height || 200;
        const pad = {l: 2, r: 66, t: 12, b: 24};
        const all = spec.series.flatMap((s) => s.values);
        const sc = scaleY(0, Math.max(1, ...all), 3);
        const n = spec.labels.length;
        const band = (W - pad.l - pad.r) / n;
        const k = spec.series.length;
        const bw = Math.max(3, Math.min(24, (band * 0.72 - 2 * (k - 1)) / k));
        const gw = bw * k + 2 * (k - 1);
        const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / sc.hi);
        let grid = '';
        for (const v of sc.list) {
            grid += `<line class="grid" x1="0" x2="${W - pad.r + 6}" y1="${y(v)}" y2="${y(v)}"/>`;
            if (v > 0) {
                grid += `<text class="tick" x="${W - 2}" y="${y(v) + 4}" text-anchor="end">${esc(C.fmtMoneyCompact(v))}</text>`;
            }
        }
        let bars = '';
        let labels = '';
        for (let i = 0; i < n; i++) {
            const gx = pad.l + band * i + (band - gw) / 2;
            spec.series.forEach((s, j) => {
                const v = s.values[i];
                if (v > 0) {
                    const top = y(v);
                    bars += `<path class="${s.cls}" d="${colPath(gx + j * (bw + 2), top, bw, H - pad.b - top)}"/>`;
                }
            });
            labels += `<text class="tick" x="${pad.l + band * i + band / 2}" y="${H - 6}" text-anchor="middle">${esc(spec.labels[i])}</text>`;
        }
        el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}
            <rect class="band" x="0" y="${pad.t}" width="${band}" height="${H - pad.t - pad.b}" visibility="hidden"/>
            ${bars}<line class="base" x1="0" x2="${W - pad.r + 6}" y1="${H - pad.b}" y2="${H - pad.b}"/>${labels}
            <rect class="hit" x="0" y="0" width="${W}" height="${H}"/></svg>`;
        const s = $('svg', el);
        const bandEl = $('.band', s);
        const tip = tooltipEl(el);
        const show = (ev) => {
            const r = s.getBoundingClientRect();
            const i = Math.max(0, Math.min(n - 1, Math.floor((ev.clientX - r.left - pad.l) / band)));
            bandEl.setAttribute('x', pad.l + band * i);
            bandEl.setAttribute('visibility', 'visible');
            placeTip(el, tip, pad.l + band * i + band / 2, spec.tips[i]);
        };
        const hide = () => {
            bandEl.setAttribute('visibility', 'hidden');
            tip.hidden = true;
        };
        s.addEventListener('pointermove', show);
        s.addEventListener('pointerdown', show);
        s.addEventListener('pointerleave', hide);
    }

    function legend(series) {
        return `<div class="legend">${series.map((s) => `<span><i class="sw ${s.cls}"></i>${esc(s.name)}</span>`).join('')}</div>`;
    }

    // ----------------------------------------------------------------- telas

    const VIEWS = {};

    VIEWS.painel = () => {
        const own = ownAccounts();
        if (!own.length) {
            return {
                title: 'Painel', large: true,
                body: `<div class="welcome">
                    <div class="glow" aria-hidden="true"></div>
                    <h2>Bem-vindo ao Vagalume</h2>
                    <p>Controle suas finanças em reais, direto no Claude. Para começar, cadastre a conta onde seu dinheiro está hoje.</p>
                    <button type="button" class="btn primary" data-act="comecar">Cadastrar minha primeira conta</button>
                    <button type="button" class="btn plain" data-go="backup">Restaurar um backup</button>
                </div>`,
            };
        }
        const mk = ui.month;
        const t = today();
        const isCur = C.monthKey(t) === mk;
        const end = isCur ? t : C.monthEnd(mk);
        const balances = C.computeBalances(S, end);
        const nw = C.netWorth(S, end, balances);
        const sum = C.summarize(S, C.monthStart(mk), C.monthEnd(mk));
        const bills = Object.values(S.bills).filter((b) => b.active !== false).map((b) => C.billMonthStatus(S, b, mk, t));
        const billsLeft = bills.reduce((s, b) => s + b.remaining, 0);
        const budgets = C.budgetOverview(S, mk, t);
        const budgetLeft = budgets.reduce((s, b) => s + (b.left != null ? Math.max(0, b.left) : 0), 0);
        const assetIds = own.filter((a) => C.groupOf(a) === 'ativo' && a.kind !== 'cartao').map((a) => a.id);
        const series = C.dailyBalance(S, assetIds, C.monthStart(mk), end);

        let body = monthNav('month', mk);
        body += `<div class="hero"><span class="hero-label">Patrimônio líquido</span>
            <span class="hero-value ${nw < 0 ? 'neg' : ''}">${signedMoney(nw)}</span>
            <span class="hero-sub">${isCur ? 'hoje, ' + esc(C.fmtDate(t, 'longa')) : 'em ' + esc(C.fmtDate(end, 'longa'))}</span></div>`;
        body += tiles([
            {label: 'Receitas', value: money(sum.income)},
            {label: 'Despesas', value: money(sum.expense)},
            {label: 'Saldo do mês', value: signedMoney(sum.net), cls: amountClass(sum.net)},
            {label: 'Contas a pagar', value: money(billsLeft), sub: budgets.length ? 'Orçamentos: ' + money(budgetLeft) + ' livres' : ''},
        ]);
        if (series.length > 1) {
            body += section('Saldo nas contas', `<div class="group pad">${chart({
                kind: 'linha', height: 170, label: 'Saldo somado das contas ao longo do mês',
                values: series.map((p) => p.value), labels: series.map((p) => C.fmtDate(p.date, 'curta')),
                tips: series.map((p) => C.fmtDate(p.date, 'dia')),
            })}</div>`);
        }
        body += section('Contas', `<div class="group">${own.map((a) => rowLink('conta', a.id, esc(a.name),
            esc(C.ACCOUNT_KINDS[a.kind].label), `<span class="amount ${amountClass(balances[a.id])}">${signedMoney(balances[a.id] || 0)}</span>`)).join('')}</div>`, seeAll('contas'));
        if (budgets.length) {
            body += section('Orçamentos', `<div class="group">${budgets.slice(0, 5).map(budgetRow).join('')}</div>`, seeAll('orcamentos'));
        }
        const billsShown = bills.filter((b) => b.dates.length || b.paid.length).sort((a, b) => (a.nextDate || '9') < (b.nextDate || '9') ? -1 : 1);
        if (billsShown.length) {
            body += section('Contas recorrentes', `<div class="group">${billsShown.slice(0, 6).map(billRow).join('')}</div>`, seeAll('contasRecorrentes'));
        }
        const piggies = Object.values(S.piggies).filter((p) => p.active !== false).sort(byName);
        if (piggies.length) {
            body += section('Cofrinhos', `<div class="group">${piggies.slice(0, 4).map(piggyRow).join('')}</div>`, seeAll('cofrinhos'));
        }
        const recent = C.txInRange(S, null, null);
        body += section('Últimos lançamentos', recent.length ? txList(recent, null, 6) : empty('Nenhum lançamento ainda. Toque em + para registrar o primeiro.'), seeAll('lancamentos'));
        return {title: 'Painel', large: true, body};
    };

    function budgetRow(o) {
        const b = o.budget;
        let sub;
        if (o.limit == null) {
            sub = 'Gasto ' + money(o.spent) + ' · sem valor definido';
        } else if (o.left >= 0) {
            sub = `Restam ${money(o.left)} de ${money(o.limit)}${o.perDay ? ' · ' + money(o.perDay) + ' por dia' : ''}`;
        } else {
            sub = `<span class="neg">Passou ${money(-o.left)}</span> de ${money(o.limit)}`;
        }
        return `<button type="button" class="row stack" data-go="orcamento" data-id="${esc(b.id)}">
            <span class="row-line"><span class="row-title">${esc(b.name)}</span><span class="row-right">${money(o.spent)}</span>${ICON.chevron}</span>
            ${meter(o.spent, o.limit)}<span class="row-sub">${sub}</span></button>`;
    }

    function billRow(st) {
        const b = st.bill;
        const range = b.amountMin === b.amountMax ? money(b.amountMin) : `${money(b.amountMin)} a ${money(b.amountMax)}`;
        let sub = range;
        if (st.status === 'paga') {
            sub += ' · pago ' + money(st.paidAmount);
        } else if (st.nextDate) {
            sub += ' · vence ' + esc(C.fmtDate(st.nextDate, 'curta'));
        }
        return rowLink('contaRecorrente', b.id, esc(b.name), sub, chip(b.active === false ? 'inativa' : st.status));
    }

    function piggyRow(p) {
        const i = C.piggyInfo(p, today());
        return `<button type="button" class="row stack" data-go="cofrinho" data-id="${esc(p.id)}">
            <span class="row-line"><span class="row-title">${esc(p.name)}</span><span class="row-right">${Math.round(i.pct * 100)}%</span>${ICON.chevron}</span>
            ${meter(i.saved, i.target)}<span class="row-sub">${money(i.saved)} de ${money(i.target)}${p.targetDate ? ' até ' + esc(C.fmtDate(p.targetDate)) : ''}</span></button>`;
    }

    // Lançamentos

    function filteredTx() {
        const q = ui.search.trim().toLocaleLowerCase('pt-BR');
        const typeOk = (t) => ui.txFilter === 'todos' || t.type === ui.txFilter;
        if (q) {
            return C.txInRange(S, null, null, (t) => typeOk(t) && [
                t.description, accName(t.source), accName(t.dest), t.notes,
                t.categoryId && S.categories[t.categoryId] ? S.categories[t.categoryId].name : '',
                (t.tags || []).join(' '), C.moneyToInput(t.amount),
            ].join(' ').toLocaleLowerCase('pt-BR').includes(q));
        }
        return C.txInRange(S, C.monthStart(ui.month), C.monthEnd(ui.month), typeOk);
    }

    function txListBlock() {
        const list = filteredTx();
        let inc = 0;
        let out = 0;
        for (const t of list) {
            if (t.type === 'deposito') {
                inc += t.amount;
            } else if (t.type === 'retirada') {
                out += t.amount;
            }
        }
        const head = ui.search.trim()
            ? `<p class="muted">${list.length} resultado${list.length === 1 ? '' : 's'} em todos os meses</p>`
            : `<p class="muted">Entradas <b class="pos">${money(inc)}</b> · Saídas <b class="neg">${money(out)}</b></p>`;
        return head + txList(list.slice(0, 300)) + (list.length > 300 ? `<p class="muted center">Mostrando 300 de ${list.length}. Refine a busca.</p>` : '');
    }

    VIEWS.lancamentos = () => {
        const seg = [['todos', 'Todos'], ['retirada', 'Despesas'], ['deposito', 'Receitas'], ['transferencia', 'Transf.']];
        const body = `${monthNav('month', ui.month)}
            <div class="searchbox">${ICON.search}<input id="busca" type="search" placeholder="Buscar em todos os meses" value="${esc(ui.search)}" autocomplete="off" aria-label="Buscar lançamentos"></div>
            <div class="seg" role="tablist">${seg.map(([v, l]) => `<button type="button" role="tab" aria-selected="${ui.txFilter === v}" data-act="filtro-tx" data-v="${v}">${l}</button>`).join('')}</div>
            <div id="tx-list">${txListBlock()}</div>`;
        return {
            title: 'Lançamentos', large: true, body,
            actions: [{act: 'novo-lancamento', icon: 'plus', label: 'Novo lançamento'}],
            after: (root) => {
                const input = $('#busca', root);
                input.addEventListener('input', () => {
                    ui.search = input.value;
                    $('#tx-list').innerHTML = txListBlock();
                });
            },
        };
    };

    // Contas

    VIEWS.contas = () => {
        const seg = [['minhas', 'Minhas contas'], ['despesa', 'Despesas'], ['receita', 'Receitas']];
        let body = `<div class="seg" role="tablist">${seg.map(([v, l]) => `<button type="button" role="tab" aria-selected="${ui.accTab === v}" data-act="aba-contas" data-v="${v}">${l}</button>`).join('')}</div>`;
        const balances = C.computeBalances(S);
        const row = (a, sub) => rowLink('conta', a.id, esc(a.name), sub || esc(C.ACCOUNT_KINDS[a.kind].label),
            `<span class="amount ${amountClass(balances[a.id])}">${signedMoney(balances[a.id] || 0)}</span>`);
        if (ui.accTab === 'minhas') {
            const all = ownAccounts(true);
            const groups = [
                ['Contas', all.filter((a) => a.active !== false && C.groupOf(a) === 'ativo' && a.kind !== 'cartao')],
                ['Cartões de crédito', all.filter((a) => a.active !== false && a.kind === 'cartao')],
                ['Passivos', all.filter((a) => a.active !== false && C.groupOf(a) === 'passivo')],
                ['Inativas', all.filter((a) => a.active === false)],
            ];
            body += `<div class="hero small"><span class="hero-label">Patrimônio líquido</span><span class="hero-value">${signedMoney(C.netWorth(S, null, balances))}</span></div>`;
            for (const [title, list] of groups) {
                if (!list.length) {
                    continue;
                }
                const total = list.reduce((s, a) => s + (balances[a.id] || 0), 0);
                body += section(title, `<div class="group">${list.map((a) => row(a)).join('')}</div>`, `<span class="sec-total ${amountClass(total)}">${signedMoney(total)}</span>`);
            }
            if (!all.length) {
                body += empty('Você ainda não tem contas.', '<button type="button" class="btn primary" data-act="nova-conta">Nova conta</button>');
            }
        } else {
            const grupo = ui.accTab;
            const mk = ui.month;
            const sum = C.summarize(S, C.monthStart(mk), C.monthEnd(mk));
            const map = grupo === 'despesa' ? sum.byExpenseAccount : sum.byRevenueAccount;
            const list = counterparties(grupo).sort((a, b) => (map[b.id] || 0) - (map[a.id] || 0) || byName(a, b));
            body += monthNav('month', mk);
            body += `<p class="muted">${grupo === 'despesa' ? 'Para quem você pagou' : 'De quem você recebeu'} em ${esc(C.fmtMonth(mk))}. Elas são criadas sozinhas quando você digita um nome novo num lançamento.</p>`;
            body += list.length
                ? `<div class="group">${list.map((a) => rowLink('conta', a.id, esc(a.name), '', `<span class="amount">${money(map[a.id] || 0)}</span>`)).join('')}</div>`
                : empty('Nenhuma conta ainda.');
        }
        return {title: 'Contas', large: true, body, actions: [{act: 'nova-conta', icon: 'plus', label: 'Nova conta'}]};
    };

    VIEWS.conta = (p) => {
        const a = S.accounts[p.id];
        if (!a) {
            return {title: 'Conta', body: empty('Esta conta não existe mais.')};
        }
        const mk = ui.month;
        const own = C.isOwn(a);
        const list = C.txInRange(S, C.monthStart(mk), C.monthEnd(mk), (t) => t.source === a.id || t.dest === a.id);
        let body = '';
        if (own) {
            const bal = C.computeBalances(S)[a.id] || 0;
            const debt = C.isDebtLike(a) && bal < 0;
            body += `<div class="hero"><span class="hero-label">${debt ? 'Valor devido' : 'Saldo atual'}</span>
                <span class="hero-value ${bal < 0 && !debt ? 'neg' : ''}">${money(debt ? -bal : bal)}</span>
                <span class="hero-sub">${esc(C.ACCOUNT_KINDS[a.kind].label)}${a.active === false ? ' · inativa' : ''}</span></div>`;
            const info = [];
            if (a.kind === 'cartao' && a.creditLimit) {
                info.push(['Limite', money(a.creditLimit)], ['Disponível', money(a.creditLimit + bal)]);
            }
            const reserved = C.piggySavedByAccount(S)[a.id];
            if (reserved) {
                info.push(['Guardado em cofrinhos', money(reserved)], ['Livre para usar', money(bal - reserved)]);
            }
            if (a.notes) {
                info.push(['Notas', esc(a.notes)]);
            }
            if (info.length) {
                body += `<div class="group">${info.map(([k, v]) => `<div class="row static"><span class="row-main">${k}</span><span class="row-right">${v}</span></div>`).join('')}</div>`;
            }
            body += monthNav('month', mk);
            const t = today();
            const end = C.monthKey(t) === mk ? t : C.monthEnd(mk);
            const series = C.dailyBalance(S, [a.id], C.monthStart(mk), end);
            if (series.length > 1) {
                body += `<div class="group pad">${chart({
                    kind: 'linha', height: 160, label: 'Saldo da conta ao longo do mês',
                    values: series.map((x) => x.value), labels: series.map((x) => C.fmtDate(x.date, 'curta')),
                    tips: series.map((x) => C.fmtDate(x.date, 'dia')),
                })}</div>`;
            }
        } else {
            const total = list.reduce((s, t) => s + t.amount, 0);
            body += `<div class="hero small"><span class="hero-label">${C.groupOf(a) === 'despesa' ? 'Gasto em ' : 'Recebido em '}${esc(C.fmtMonth(mk))}</span>
                <span class="hero-value">${money(total)}</span></div>`;
            body += monthNav('month', mk);
        }
        body += txList(list, a.id);
        return {title: a.name, body, actions: [{act: 'editar-conta', id: a.id, icon: 'edit', label: 'Editar conta'}]};
    };

    // Mais

    VIEWS.mais = () => {
        const items = [
            ['orcamentos', 'Orçamentos'], ['categorias', 'Categorias'], ['tags', 'Tags'],
            ['contasRecorrentes', 'Contas recorrentes'], ['recorrencias', 'Lançamentos recorrentes'],
            ['cofrinhos', 'Cofrinhos'], ['regras', 'Regras'], ['relatorios', 'Relatórios'],
        ];
        const sys = [['backup', 'Backup e restauração'], ['sobre', 'Sobre e licença']];
        const r = ([go, label]) => rowLink(go, null, label, '', '', `<span class="menu-ico">${ICON[go === 'contasRecorrentes' ? 'bills' : go]}</span>`);
        return {
            title: 'Mais', large: true,
            body: `<div class="group">${items.map(r).join('')}</div><div class="group">${sys.map(r).join('')}</div>
                <p class="muted center small">Vagalume é baseado no Firefly III. Licença AGPL-3.0.</p>`,
        };
    };

    // Orçamentos

    VIEWS.orcamentos = () => {
        const mk = ui.month;
        const list = C.budgetOverview(S, mk, today());
        const totalLimit = list.reduce((s, o) => s + (o.limit || 0), 0);
        const totalSpent = list.reduce((s, o) => s + o.spent, 0);
        const sum = C.summarize(S, C.monthStart(mk), C.monthEnd(mk));
        const noBudget = sum.byBudget[''] || 0;
        let body = monthNav('month', mk);
        if (list.length) {
            body += tiles([
                {label: 'Orçado', value: money(totalLimit)},
                {label: 'Gasto', value: money(totalSpent)},
                {label: 'Restante', value: signedMoney(totalLimit - totalSpent), cls: amountClass(totalLimit - totalSpent)},
                {label: 'Fora de orçamento', value: money(noBudget)},
            ]);
            body += `<div class="group">${list.map(budgetRow).join('')}</div>`;
        } else {
            body += empty('Orçamentos limitam quanto você quer gastar por mês em cada área, como mercado ou lazer.',
                '<button type="button" class="btn primary" data-act="novo-orcamento">Criar orçamento</button>');
        }
        const inactive = Object.values(S.budgets).filter((b) => b.active === false).sort(byName);
        if (inactive.length) {
            body += section('Inativos', `<div class="group">${inactive.map((b) => rowLink('orcamento', b.id, esc(b.name))).join('')}</div>`);
        }
        return {title: 'Orçamentos', large: true, body, actions: [{act: 'novo-orcamento', icon: 'plus', label: 'Novo orçamento'}]};
    };

    VIEWS.orcamento = (p) => {
        const b = S.budgets[p.id];
        if (!b) {
            return {title: 'Orçamento', body: empty('Este orçamento não existe mais.')};
        }
        const mk = ui.month;
        const [o] = C.budgetOverview(S, mk, today()).filter((x) => x.budget.id === b.id).concat([{
            budget: b, limit: C.budgetLimit(b, mk), spent: C.budgetSpent(S, b.id, mk),
        }]);
        const left = o.limit != null ? o.limit - o.spent : null;
        let body = monthNav('month', mk);
        body += `<div class="hero"><span class="hero-label">${left == null ? 'Gasto no mês' : left >= 0 ? 'Restante' : 'Acima do limite'}</span>
            <span class="hero-value ${left != null && left < 0 ? 'neg' : ''}">${money(left == null ? o.spent : Math.abs(left))}</span>
            ${o.limit != null ? `<div class="hero-meter">${meter(o.spent, o.limit)}</div><span class="hero-sub">Gasto ${money(o.spent)} de ${money(o.limit)}</span>` : ''}</div>`;
        const custom = b.limits && b.limits[mk] != null;
        body += `<div class="group">
            <button type="button" class="row" data-act="limite-orcamento" data-id="${esc(b.id)}"><span class="row-main"><span class="row-title">Valor para ${esc(C.fmtMonth(mk))}</span>
            <span class="row-sub">${custom ? 'Definido só para este mês' : b.defaultAmount != null ? 'Usando o valor mensal padrão' : 'Sem valor definido'}</span></span>
            <span class="row-right">${o.limit != null ? money(o.limit) : '—'}</span>${ICON.chevron}</button></div>`;
        body += txList(C.txInRange(S, C.monthStart(mk), C.monthEnd(mk), (t) => t.budgetId === b.id));
        return {title: b.name, body, actions: [{act: 'editar-orcamento', id: b.id, icon: 'edit', label: 'Editar orçamento'}]};
    };

    // Categorias

    VIEWS.categorias = () => {
        const mk = ui.month;
        const sum = C.summarize(S, C.monthStart(mk), C.monthEnd(mk));
        const cats = Object.values(S.categories).sort((a, b) => (sum.byCategory[b.id] || 0) - (sum.byCategory[a.id] || 0) || byName(a, b));
        let body = monthNav('month', mk);
        if (!cats.length) {
            body += empty('Categorias agrupam seus gastos e receitas, como Alimentação ou Transporte.',
                '<button type="button" class="btn primary" data-act="nova-categoria">Criar categoria</button>');
        } else {
            const rows = cats.map((c) => {
                const out = sum.byCategory[c.id] || 0;
                const inc = sum.byCategoryIncome[c.id] || 0;
                const sub = [out ? 'Gastos ' + money(out) : '', inc ? 'Receitas ' + money(inc) : ''].filter(Boolean).join(' · ') || 'Sem movimento no mês';
                return rowLink('categoria', c.id, esc(c.name), sub);
            });
            if (sum.byCategory[''] || sum.byCategoryIncome['']) {
                rows.push(rowLink('categoria', '__sem', '<i>Sem categoria</i>',
                    [sum.byCategory[''] ? 'Gastos ' + money(sum.byCategory['']) : '', sum.byCategoryIncome[''] ? 'Receitas ' + money(sum.byCategoryIncome['']) : ''].filter(Boolean).join(' · ')));
            }
            body += `<div class="group">${rows.join('')}</div>`;
        }
        return {title: 'Categorias', large: true, body, actions: [{act: 'nova-categoria', icon: 'plus', label: 'Nova categoria'}]};
    };

    VIEWS.categoria = (p) => {
        const none = p.id === '__sem';
        const c = S.categories[p.id];
        if (!none && !c) {
            return {title: 'Categoria', body: empty('Esta categoria não existe mais.')};
        }
        const mk = ui.month;
        const list = C.txInRange(S, C.monthStart(mk), C.monthEnd(mk), (t) => (none ? !t.categoryId && t.type !== 'transferencia' : t.categoryId === c.id));
        let out = 0;
        let inc = 0;
        for (const t of list) {
            if (t.type === 'retirada') {
                out += t.amount;
            } else if (t.type === 'deposito') {
                inc += t.amount;
            }
        }
        let body = monthNav('month', mk) + tiles([{label: 'Gastos', value: money(out)}, {label: 'Receitas', value: money(inc)}]);
        body += txList(list);
        return {
            title: none ? 'Sem categoria' : c.name, body,
            actions: none ? [] : [{act: 'editar-categoria', id: c.id, icon: 'edit', label: 'Editar categoria'}],
        };
    };

    // Tags

    VIEWS.tags = () => {
        const map = {};
        for (const t of Object.values(S.tx)) {
            for (const tag of t.tags || []) {
                const k = tag.toLocaleLowerCase('pt-BR');
                map[k] = map[k] || {name: tag, count: 0, spent: 0};
                map[k].count++;
                if (t.type === 'retirada') {
                    map[k].spent += t.amount;
                }
            }
        }
        const list = Object.values(map).sort(byName);
        const body = list.length
            ? `<div class="group">${list.map((x) => rowLink('tag', x.name, '#' + esc(x.name), `${x.count} lançamento${x.count === 1 ? '' : 's'} · gastos ${money(x.spent)}`)).join('')}</div>`
            : empty('Tags são marcadores livres, como #viagem ou #reforma. Adicione tags ao criar um lançamento.');
        return {title: 'Tags', large: true, body};
    };

    VIEWS.tag = (p) => {
        const k = p.id.toLocaleLowerCase('pt-BR');
        const list = C.txInRange(S, null, null, (t) => (t.tags || []).some((x) => x.toLocaleLowerCase('pt-BR') === k));
        const spent = list.filter((t) => t.type === 'retirada').reduce((s, t) => s + t.amount, 0);
        return {title: '#' + p.id, body: tiles([{label: 'Lançamentos', value: String(list.length)}, {label: 'Gastos', value: money(spent)}]) + txList(list)};
    };

    // Contas recorrentes

    VIEWS.contasRecorrentes = () => {
        const mk = ui.month;
        const t = today();
        const all = Object.values(S.bills).sort(byName);
        const active = all.filter((b) => b.active !== false).map((b) => C.billMonthStatus(S, b, mk, t));
        let body = monthNav('month', mk);
        if (!all.length) {
            body += empty('Contas recorrentes são compromissos que se repetem, como aluguel, luz ou assinaturas. O Vagalume mostra o que já foi pago e o que falta.',
                '<button type="button" class="btn primary" data-act="nova-conta-recorrente">Nova conta recorrente</button>');
            return {title: 'Contas recorrentes', large: true, body};
        }
        const paid = active.reduce((s, b) => s + b.paidAmount, 0);
        const left = active.reduce((s, b) => s + b.remaining, 0);
        body += tiles([{label: 'Já pago', value: money(paid)}, {label: 'Falta pagar', value: money(left)}]);
        const order = {atrasada: 0, pendente: 1, paga: 2, sem_vencimento: 3};
        active.sort((a, b) => order[a.status] - order[b.status] || (a.nextDate || '').localeCompare(b.nextDate || ''));
        body += `<div class="group">${active.map(billRow).join('')}</div>`;
        const inactive = all.filter((b) => b.active === false);
        if (inactive.length) {
            body += section('Inativas', `<div class="group">${inactive.map((b) => billRow(C.billMonthStatus(S, b, mk, t))).join('')}</div>`);
        }
        return {title: 'Contas recorrentes', large: true, body, actions: [{act: 'nova-conta-recorrente', icon: 'plus', label: 'Nova conta recorrente'}]};
    };

    VIEWS.contaRecorrente = (p) => {
        const b = S.bills[p.id];
        if (!b) {
            return {title: 'Conta recorrente', body: empty('Esta conta recorrente não existe mais.')};
        }
        const next = C.nextBillDate(b, today());
        const info = [
            ['Valor', b.amountMin === b.amountMax ? money(b.amountMin) : `${money(b.amountMin)} a ${money(b.amountMax)}`],
            ['Frequência', esc(freqText(C.BILL_FREQ, b.repeatFreq, b.skip))],
            ['Próximo vencimento', next ? esc(C.fmtDate(next)) : '—'],
        ];
        if (b.endDate) {
            info.push(['Termina em', esc(C.fmtDate(b.endDate))]);
        }
        if (b.notes) {
            info.push(['Notas', esc(b.notes)]);
        }
        let body = `<div class="group">${info.map(([k, v]) => `<div class="row static"><span class="row-main">${k}</span><span class="row-right">${v}</span></div>`).join('')}</div>`;
        body += `<p class="muted">Lançamentos vinculados a esta conta. Para vincular sozinho, use uma regra com a ação "Vincular à conta recorrente".</p>`;
        body += txList(C.txInRange(S, null, null, (t) => t.billId === b.id));
        return {title: b.name, body, actions: [{act: 'editar-conta-recorrente', id: b.id, icon: 'edit', label: 'Editar conta recorrente'}]};
    };

    function freqText(table, freq, skip) {
        const f = table[freq];
        if (!f) {
            return '';
        }
        const n = (skip || 0) + 1;
        if (n === 1) {
            return f.label;
        }
        const unit = f.days === 1 ? 'dias' : f.days === 7 ? 'semanas' : f.months === 12 ? 'anos' : f.months === 1 ? 'meses' : f.months === 3 ? 'trimestres' : 'semestres';
        return `A cada ${n} ${unit}`;
    }

    // Recorrências

    VIEWS.recorrencias = () => {
        const list = Object.values(S.recurrences).sort((a, b) => byName({name: a.title}, {name: b.title}));
        const t = today();
        const body = list.length
            ? `<p class="muted">O Vagalume cria estes lançamentos sozinho quando você abre o app, na data de cada repetição.</p>
               <div class="group">${list.map((r) => {
                const next = C.recurrenceDates(r, r.lastCreated ? C.addDays(r.lastCreated, 1) : r.firstDate, C.addDays(t, 800))[0];
                const sub = `${esc(freqText(C.REC_FREQ, r.repeatFreq, r.skip))} · ${r.active === false ? 'pausada' : next ? 'próximo em ' + esc(C.fmtDate(next)) : 'encerrada'}`;
                const sign = r.type === 'retirada' ? MINUS : r.type === 'deposito' ? '+' : '';
                return `<button type="button" class="row" data-act="editar-recorrencia" data-id="${esc(r.id)}">
                    <span class="tx-ico ${r.type}">${ICON[r.type]}</span>
                    <span class="row-main"><span class="row-title">${esc(r.title)}</span><span class="row-sub">${sub}</span></span>
                    <span class="amount ${r.type === 'retirada' ? 'neg' : r.type === 'deposito' ? 'pos' : ''}">${sign}${money(r.amount)}</span>${ICON.chevron}</button>`;
            }).join('')}</div>`
            : empty('Lançamentos recorrentes são criados sozinhos, como o salário todo dia 5 ou a mensalidade da academia.',
                '<button type="button" class="btn primary" data-act="nova-recorrencia">Nova recorrência</button>');
        return {title: 'Recorrências', large: true, body, actions: [{act: 'nova-recorrencia', icon: 'plus', label: 'Nova recorrência'}]};
    };

    // Cofrinhos

    VIEWS.cofrinhos = () => {
        const list = Object.values(S.piggies).sort(byName);
        const active = list.filter((p) => p.active !== false);
        let body;
        if (!list.length) {
            body = empty('Cofrinhos ajudam a juntar dinheiro para um objetivo, como uma viagem ou uma reserva de emergência.',
                '<button type="button" class="btn primary" data-act="novo-cofrinho">Novo cofrinho</button>');
        } else {
            const saved = active.reduce((s, p) => s + C.piggyInfo(p).saved, 0);
            const target = active.reduce((s, p) => s + (p.target || 0), 0);
            body = tiles([{label: 'Guardado', value: money(saved)}, {label: 'Metas somadas', value: money(target)}]);
            body += `<div class="group">${active.map(piggyRow).join('')}</div>`;
            const inactive = list.filter((p) => p.active === false);
            if (inactive.length) {
                body += section('Inativos', `<div class="group">${inactive.map(piggyRow).join('')}</div>`);
            }
        }
        return {title: 'Cofrinhos', large: true, body, actions: [{act: 'novo-cofrinho', icon: 'plus', label: 'Novo cofrinho'}]};
    };

    VIEWS.cofrinho = (p) => {
        const pg = S.piggies[p.id];
        if (!pg) {
            return {title: 'Cofrinho', body: empty('Este cofrinho não existe mais.')};
        }
        const i = C.piggyInfo(pg, today());
        let body = `<div class="hero"><span class="hero-label">Guardado</span><span class="hero-value">${money(i.saved)}</span>
            <div class="hero-meter">${meter(i.saved, i.target)}</div>
            <span class="hero-sub">${Math.round(i.pct * 100)}% de ${money(i.target)} · na conta ${esc(accName(pg.accountId))}</span></div>`;
        const info = [['Falta', money(i.left)]];
        if (pg.targetDate) {
            info.push(['Data alvo', esc(C.fmtDate(pg.targetDate))]);
        }
        if (i.perMonth) {
            info.push(['Guardar por mês', money(i.perMonth)]);
        }
        if (pg.notes) {
            info.push(['Notas', esc(pg.notes)]);
        }
        body += `<div class="group">${info.map(([k, v]) => `<div class="row static"><span class="row-main">${k}</span><span class="row-right">${v}</span></div>`).join('')}</div>`;
        body += `<div class="btn-row"><button type="button" class="btn primary" data-act="cofrinho-mov" data-id="${esc(pg.id)}" data-sign="1">Guardar</button>
            <button type="button" class="btn" data-act="cofrinho-mov" data-id="${esc(pg.id)}" data-sign="-1" ${i.saved <= 0 ? 'disabled' : ''}>Retirar</button></div>`;
        const ev = (pg.events || []).map((e, idx) => Object.assign({idx}, e)).sort((a, b) => (a.date < b.date ? 1 : -1));
        body += section('Movimentos', ev.length ? `<div class="group">${ev.map((e) => `<button type="button" class="row" data-act="cofrinho-apagar-mov" data-id="${esc(pg.id)}" data-idx="${e.idx}">
            <span class="row-main"><span class="row-title">${e.amount >= 0 ? 'Guardado' : 'Retirado'}</span><span class="row-sub">${esc(C.fmtDate(e.date))}${e.note ? ' · ' + esc(e.note) : ''}</span></span>
            <span class="amount ${e.amount >= 0 ? 'pos' : 'neg'}">${e.amount >= 0 ? '+' : MINUS}${money(Math.abs(e.amount))}</span></button>`).join('')}</div>` : empty('Nenhum movimento ainda.'));
        return {title: pg.name, body, actions: [{act: 'editar-cofrinho', id: pg.id, icon: 'edit', label: 'Editar cofrinho'}]};
    };

    // Regras

    function valueText(input, v) {
        if (input === 'valor') {
            return money(+v);
        }
        if (input === 'tipo') {
            return C.TX_TYPES[v] ? C.TX_TYPES[v].label.toLowerCase() : '?';
        }
        if (input === 'categoria') {
            return S.categories[v] ? esc(S.categories[v].name) : '(categoria apagada)';
        }
        if (input === 'orcamento') {
            return S.budgets[v] ? esc(S.budgets[v].name) : '(orçamento apagado)';
        }
        if (input === 'conta_recorrente') {
            return S.bills[v] ? esc(S.bills[v].name) : '(conta apagada)';
        }
        return '"' + esc(v) + '"';
    }

    function ruleSummary(r) {
        const tr = (r.triggers || []).filter((x) => C.RULE_TRIGGERS[x.type]).map((x) => {
            const d = C.RULE_TRIGGERS[x.type];
            return esc(d.label.toLowerCase()) + (d.input ? ' ' + valueText(d.input, x.value) : '');
        });
        const ac = (r.actions || []).filter((x) => C.RULE_ACTIONS[x.type]).map((x) => {
            const d = C.RULE_ACTIONS[x.type];
            return esc(d.label.toLowerCase()) + (d.input ? ' ' + valueText(d.input, x.value) : '');
        });
        return `Se ${tr.join(r.strict === false ? ' ou ' : ' e ')} → ${ac.join(', ')}`;
    }

    VIEWS.regras = () => {
        const list = C.sortedRules(S);
        const body = list.length
            ? `<p class="muted">As regras rodam em ordem sempre que você cria um lançamento. Exemplo: se a descrição contém "uber", definir a categoria Transporte.</p>
               <div class="group">${list.map((r) => `<button type="button" class="row" data-act="editar-regra" data-id="${esc(r.id)}">
                <span class="row-main"><span class="row-title">${esc(r.title)}${r.active === false ? ' <span class="chip muted">Inativa</span>' : ''}</span>
                <span class="row-sub">${ruleSummary(r)}</span></span>${ICON.chevron}</button>`).join('')}</div>`
            : empty('Regras organizam seus lançamentos sozinhas. Exemplo: se a descrição contém "uber", definir a categoria Transporte.',
                '<button type="button" class="btn primary" data-act="nova-regra">Criar regra</button>');
        return {title: 'Regras', large: true, body, actions: [{act: 'nova-regra', icon: 'plus', label: 'Nova regra'}]};
    };

    // Relatórios

    VIEWS.relatorios = () => {
        const seg = [['mes', 'Mês'], ['ano', 'Ano']];
        let body = `<div class="seg" role="tablist">${seg.map(([v, l]) => `<button type="button" role="tab" aria-selected="${ui.reportMode === v}" data-act="modo-relatorio" data-v="${v}">${l}</button>`).join('')}</div>`;
        const catName = (e) => (e.id === '__outros' ? `Outras (${e.count})` : e.id ? (S.categories[e.id] ? S.categories[e.id].name : '(apagada)') : 'Sem categoria');
        const s1 = 'Receitas';
        const s2 = 'Despesas';
        if (ui.reportMode === 'mes') {
            const mk = ui.reportMonth;
            const sum = C.summarize(S, C.monthStart(mk), C.monthEnd(mk));
            body += monthNav('reportMonth', mk);
            body += tiles([
                {label: s1, value: money(sum.income)}, {label: s2, value: money(sum.expense)},
                {label: 'Saldo', value: signedMoney(sum.net), cls: amountClass(sum.net)},
                {label: 'Taxa de poupança', value: sum.income ? Math.round(sum.net / sum.income * 100) + '%' : '—'},
            ]);
            body += section('Despesas por categoria', hbars(C.topEntries(sum.byCategory, 8), catName, 'categoria-rel'));
            const budgets = C.budgetOverview(S, mk, null).filter((o) => o.limit != null || o.spent);
            if (budgets.length) {
                body += section('Orçamentos', `<div class="group">${budgets.map(budgetRow).join('')}</div>`);
            }
            body += section('Para quem você mais pagou', hbars(C.topEntries(sum.byExpenseAccount, 8), (e) => (e.id === '__outros' ? `Outros (${e.count})` : accName(e.id)), 'conta'));
            body += section('De onde veio o dinheiro', hbars(C.topEntries(sum.byRevenueAccount, 6), (e) => (e.id === '__outros' ? `Outros (${e.count})` : accName(e.id)), 'conta'));
        } else {
            const y = ui.reportYear;
            const series = C.monthlySeries(S, y + '-12', 12);
            const sumY = C.summarize(S, y + '-01-01', y + '-12-31');
            body += monthNav('reportYear', y, String(y));
            body += tiles([
                {label: s1, value: money(sumY.income)}, {label: s2, value: money(sumY.expense)},
                {label: 'Saldo do ano', value: signedMoney(sumY.net), cls: amountClass(sumY.net)},
                {label: 'Média de despesas', value: money(Math.round(sumY.expense / 12)), sub: 'por mês'},
            ]);
            const sr = [{name: s1, cls: 's1', values: series.map((m) => m.income)}, {name: s2, cls: 's2', values: series.map((m) => m.expense)}];
            body += section('Receitas e despesas', `<div class="group pad">${legend(sr)}${chart({
                kind: 'colunas', height: 210, label: 'Receitas e despesas por mês',
                labels: series.map((m) => C.fmtMonth(m.month, 'curta')), series: sr,
                tips: series.map((m) => `<b>${esc(C.fmtMonth(m.month))}</b><span><i class="sw s1"></i>${s1} ${money(m.income)}</span><span><i class="sw s2"></i>${s2} ${money(m.expense)}</span>`),
            })}</div>`);
            body += section('Patrimônio líquido', `<div class="group pad">${chart({
                kind: 'linha', height: 170, label: 'Patrimônio líquido no fim de cada mês',
                values: series.map((m) => m.netWorth), labels: series.map((m) => C.fmtMonth(m.month, 'curta')),
                tips: series.map((m) => 'fim de ' + C.fmtMonth(m.month)),
            })}</div>`);
            body += section('Mês a mês', `<div class="group table-wrap"><table class="table"><thead><tr><th>Mês</th><th>${s1}</th><th>${s2}</th><th>Saldo</th></tr></thead><tbody>
                ${series.map((m) => `<tr><td>${esc(C.fmtMonth(m.month, 'curta'))}</td><td>${money(m.income)}</td><td>${money(m.expense)}</td><td class="${amountClass(m.net)}">${signedMoney(m.net)}</td></tr>`).join('')}
                </tbody></table></div>`);
            body += section('Despesas por categoria', hbars(C.topEntries(sumY.byCategory, 10), catName, null));
        }
        return {title: 'Relatórios', large: true, body};
    };

    // Backup e Sobre

    VIEWS.backup = () => {
        const n = Object.keys(S.tx).length;
        const body = `<p class="muted">Seus dados ficam guardados no banco de dados do Claude, numa área privada só sua. Faça backups de vez em quando: o arquivo fica salvo no seu aparelho e pode ser restaurado aqui.</p>
            <div class="group">
                <button type="button" class="row" data-act="exportar"><span class="row-main"><span class="row-title">Exportar backup (.json)</span><span class="row-sub">${n} lançamento${n === 1 ? '' : 's'} e todos os cadastros</span></span>${ICON.chevron}</button>
                <label class="row" for="arquivo-backup"><span class="row-main"><span class="row-title">Restaurar backup</span><span class="row-sub">Substitui todos os dados atuais</span></span>${ICON.chevron}</label>
            </div>
            <input type="file" id="arquivo-backup" accept=".json,application/json" hidden>
            <div class="group"><button type="button" class="row danger" data-act="apagar-tudo"><span class="row-main"><span class="row-title">Apagar todos os dados</span></span></button></div>`;
        return {
            title: 'Backup', body,
            after: (root) => {
                $('#arquivo-backup', root).addEventListener('change', (e) => {
                    const f = e.target.files && e.target.files[0];
                    e.target.value = '';
                    if (f) {
                        importFile(f);
                    }
                });
            },
        };
    };

    VIEWS.sobre = () => ({
        title: 'Sobre',
        body: `<div class="about">
            <div class="glow" aria-hidden="true"></div>
            <h2>Vagalume</h2>
            <p>Gerenciador de finanças pessoais que roda direto no Claude, sem servidor próprio.</p>
            <p>O Vagalume é uma adaptação do <b>Firefly III</b>, criado por James Cole e mantido por uma comunidade de colaboradores. Este app reaproveita o modelo de dados e a organização das telas do Firefly III (contas, lançamentos em partidas dobradas, orçamentos, categorias, contas recorrentes, cofrinhos, regras e relatórios), reescritos em JavaScript.</p>
            <p>Firefly III: Copyright © James Cole &lt;james@firefly-iii.org&gt; e colaboradores.<br>Modificações: Copyright © 2026 rcbortolini.</p>
            <p>Este programa é software livre: você pode redistribuí-lo e/ou modificá-lo sob os termos da <b>GNU Affero General Public License</b>, versão 3 ou posterior, publicada pela Free Software Foundation. Ele é distribuído na esperança de que seja útil, mas sem nenhuma garantia.</p>
            </div>
            <div class="group">
                <a class="row" href="${SOURCE_URL}" target="_blank" rel="noopener"><span class="row-main"><span class="row-title">Código-fonte do Vagalume</span><span class="row-sub">github.com/rcbortolini/firefly-iii</span></span>${ICON.chevron}</a>
                <a class="row" href="${FIREFLY_URL}" target="_blank" rel="noopener"><span class="row-main"><span class="row-title">Projeto original Firefly III</span><span class="row-sub">github.com/firefly-iii/firefly-iii</span></span>${ICON.chevron}</a>
                <a class="row" href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener"><span class="row-main"><span class="row-title">Texto da licença AGPL-3.0</span><span class="row-sub">gnu.org</span></span>${ICON.chevron}</a>
            </div>`,
    });

    // --------------------------------------------------------------- render

    function currentView() {
        const top = ui.stack[ui.stack.length - 1];
        return (VIEWS[top.view] || VIEWS.painel)(top);
    }

    function render() {
        charts.clear();
        chartSeq = 0;
        const main = $('#main');
        const bar = $('#bar');
        const root = ui.stack.length === 1;
        let banner = '';
        if (store.mode === 'demo') {
            banner = `<div class="banner"><b>Exemplo.</b> Estes são dados de demonstração e nada é salvo. Abra esta página no claude.ai, com sua conta, para usar seus próprios dados.</div>`;
        } else if (store.revoked) {
            banner = `<div class="banner bad">Sem acesso ao banco de dados agora. Recarregue a página para tentar de novo.</div>`;
        }
        if (store.mode === 'carregando') {
            bar.innerHTML = '';
            main.innerHTML = `<div class="loading"><div class="glow pulse" aria-hidden="true"></div><p>Abrindo suas finanças…</p></div>`;
            return;
        }
        const v = currentView();
        const actions = (v.actions || []).map((a) => `<button type="button" class="icon-btn" data-act="${a.act}" ${a.id ? `data-id="${esc(a.id)}"` : ''} aria-label="${esc(a.label)}">${ICON[a.icon]}</button>`).join('');
        bar.innerHTML = `<div class="bar-side">${root ? '' : `<button type="button" class="back" data-act="voltar">${ICON.back}<span>Voltar</span></button>`}</div>
            <div class="bar-title">${root ? '' : esc(v.title)}</div><div class="bar-side end">${actions}</div>`;
        const focus = document.activeElement && main.contains(document.activeElement) && document.activeElement.id ? document.activeElement : null;
        const sel = focus && 'selectionStart' in focus ? [focus.selectionStart, focus.selectionEnd] : null;
        const credit = `<footer class="credit">Vagalume, baseado no <a href="${FIREFLY_URL}" target="_blank" rel="noopener">Firefly III</a> · AGPL-3.0 · <button type="button" data-go="sobre">Sobre e código-fonte</button></footer>`;
        main.innerHTML = banner + (v.large ? `<h1 class="large-title">${esc(v.title)}</h1>` : '') + v.body + credit;
        document.title = 'Vagalume';
        if (v.after) {
            v.after(main);
        }
        drawCharts(main);
        if (focus) {
            const again = document.getElementById(focus.id);
            if (again) {
                again.focus();
                try {
                    if (sel) {
                        again.setSelectionRange(sel[0], sel[1]);
                    }
                } catch (e) {
                    // campos de data não aceitam seleção
                }
            }
        }
        const tab = ui.stack[0].view;
        $$('#tabs [data-tab]').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
    }

    function go(view, params) {
        ui.stack.push(Object.assign({view}, params || {}));
        render();
        window.scrollTo(0, 0);
    }

    function tab(view) {
        ui.stack = [{view}];
        render();
        window.scrollTo(0, 0);
    }

    // ---------------------------------------------------------------- toast

    let toastTimer = null;

    function toast(msg) {
        const el = $('#toast');
        el.textContent = msg;
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            el.hidden = true;
        }, 3800);
    }

    // --------------------------------------------------------------- sheets

    const sheets = [];

    function openSheet(opts) {
        const el = document.createElement('div');
        el.className = 'sheet-wrap';
        el.innerHTML = `<div class="sheet-backdrop" data-close></div>
            <form class="sheet" novalidate role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
            <header class="sheet-head"><button type="button" class="link" data-close>Cancelar</button><h2>${esc(opts.title)}</h2>
            ${opts.onSubmit ? `<button type="submit" class="link strong">${esc(opts.submitLabel || 'Salvar')}</button>` : '<span></span>'}</header>
            <div class="sheet-body">${opts.body}<p class="form-error" role="alert" hidden></p></div></form>`;
        document.body.appendChild(el);
        sheets.push(el);
        document.body.classList.add('sheet-open');
        const form = $('form', el);
        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-close]')) {
                closeSheet(el);
            }
        });
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!opts.onSubmit) {
                return;
            }
            const res = opts.onSubmit(form, el);
            if (typeof res === 'string') {
                formError(form, res);
            } else if (res !== false) {
                closeSheet(el);
            }
        });
        if (opts.init) {
            opts.init(form, el);
        }
        requestAnimationFrame(() => el.classList.add('open'));
        return el;
    }

    function closeSheet(el) {
        const i = sheets.indexOf(el);
        if (i >= 0) {
            sheets.splice(i, 1);
        }
        el.classList.remove('open');
        setTimeout(() => el.remove(), 220);
        if (!sheets.length) {
            document.body.classList.remove('sheet-open');
        }
    }

    function formError(form, msg) {
        const p = $('.form-error', form);
        p.textContent = msg;
        p.hidden = false;
        p.scrollIntoView({block: 'nearest'});
    }

    function confirmSheet(o) {
        openSheet({
            title: o.title,
            body: `<p class="confirm-text">${esc(o.message)}</p>
                <button type="button" class="btn ${o.destructive ? 'danger' : 'primary'} wide" data-confirm>${esc(o.confirmLabel)}</button>`,
            init: (form, el) => {
                $('[data-confirm]', form).addEventListener('click', () => {
                    closeSheet(el);
                    o.onConfirm();
                });
            },
        });
    }

    // Campos de formulário (estilo Ajustes do iPhone: rótulo à esquerda, valor à direita).

    const field = (label, input, o) => `<label class="field${o && o.cls ? ' ' + o.cls : ''}"${o && o.id ? ` id="${o.id}"` : ''}${o && o.hidden ? ' hidden' : ''}><span class="field-label">${label}</span>${input}</label>`;
    const inText = (name, value, attrs) => `<input id="f-${name}" name="${name}" value="${esc(value)}" autocomplete="off" ${attrs || ''}>`;
    const inMoney = (name, cents, attrs) => `<input id="f-${name}" name="${name}" inputmode="decimal" placeholder="0,00" autocomplete="off" value="${cents == null ? '' : esc(C.moneyToInput(cents))}" ${attrs || ''}>`;
    const inDate = (name, value) => `<input type="date" id="f-${name}" name="${name}" value="${esc(value || '')}">`;
    const opt = (v, label, cur) => `<option value="${esc(v)}"${String(v) === String(cur == null ? '' : cur) ? ' selected' : ''}>${esc(label)}</option>`;
    const sel = (name, options, cur, attrs) => `<select id="f-${name}" name="${name}" ${attrs || ''}>${options.map(([v, l]) => opt(v, l, cur)).join('')}</select>`;
    const sw = (name, label, on) => `<label class="field switch"><span class="field-label">${label}</span><input type="checkbox" role="switch" id="f-${name}" name="${name}"${on ? ' checked' : ''}></label>`;
    const area = (name, value, ph) => `<textarea id="f-${name}" name="${name}" rows="2" placeholder="${esc(ph || '')}">${esc(value || '')}</textarea>`;
    const datalist = (id, values) => `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
    const val = (form, name) => (form.elements[name] ? form.elements[name].value : '');
    const checked = (form, name) => !!(form.elements[name] && form.elements[name].checked);

    function ownOptions(includeEmpty) {
        const list = ownAccounts().map((a) => [a.id, a.name]);
        return includeEmpty ? [['', '—']].concat(list) : list;
    }

    const catOptions = () => [['', 'Nenhuma']].concat(Object.values(S.categories).sort(byName).map((c) => [c.id, c.name]));
    const budgetOptions = () => [['', 'Nenhum']].concat(Object.values(S.budgets).filter((b) => b.active !== false).sort(byName).map((b) => [b.id, b.name]));
    const billOptions = () => [['', 'Nenhuma']].concat(Object.values(S.bills).filter((b) => b.active !== false).sort(byName).map((b) => [b.id, b.name]));

    function segmented(name, options, cur) {
        return `<div class="seg in-form" role="radiogroup">${options.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}"${v === cur ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
    }

    /** Campos de contas usados pelo lançamento e pela recorrência. */
    /** Conta sugerida: a usada no lançamento mais recente, senão a primeira conta corrente. */
    function defaultOwnAccount() {
        const last = C.txInRange(S, null, null, (t) => t.type !== 'transferencia')[0];
        const id = last && (last.type === 'retirada' ? last.source : last.dest);
        if (id && S.accounts[id] && S.accounts[id].active !== false) {
            return id;
        }
        const own = ownAccounts();
        return (own.find((a) => a.kind === 'corrente') || own[0] || {}).id || '';
    }

    function accountFields(t) {
        const own = ownOptions();
        const firstOwn = defaultOwnAccount();
        const isW = t.type === 'retirada';
        const isD = t.type === 'deposito';
        return `
            ${field('Conta', sel('d_src', own, isW ? t.source : firstOwn), {cls: 'only-retirada'})}
            ${field('Para', inText('d_dst', isW ? accName(t.dest) : '', 'list="dl-despesa" placeholder="Ex.: Supermercado"'), {cls: 'only-retirada'})}
            ${field('De', inText('r_src', isD ? accName(t.source) : '', 'list="dl-receita" placeholder="Ex.: Empresa"'), {cls: 'only-deposito'})}
            ${field('Conta', sel('r_dst', own, isD ? t.dest : firstOwn), {cls: 'only-deposito'})}
            ${field('De', sel('t_src', own, t.type === 'transferencia' ? t.source : firstOwn), {cls: 'only-transferencia'})}
            ${field('Para', sel('t_dst', own, t.type === 'transferencia' ? t.dest : (own.find((o) => o[0] !== firstOwn) || own[0] || [''])[0]), {cls: 'only-transferencia'})}
            ${datalist('dl-despesa', counterparties('despesa').map((a) => a.name))}
            ${datalist('dl-receita', counterparties('receita').map((a) => a.name))}`;
    }

    function readAccounts(form, type, touched) {
        if (type === 'retirada') {
            return {source: val(form, 'd_src'), dest: ensureAccount(val(form, 'd_dst'), 'despesa', touched)};
        }
        if (type === 'deposito') {
            return {source: ensureAccount(val(form, 'r_src'), 'receita', touched), dest: val(form, 'r_dst')};
        }
        return {source: val(form, 't_src'), dest: val(form, 't_dst')};
    }

    function bindTypeSwitch(form) {
        const apply = () => {
            const type = val(form, 'type');
            form.dataset.type = type;
        };
        $$('input[name="type"]', form).forEach((r) => r.addEventListener('change', apply));
        apply();
    }

    // Lançamento

    function txSheet(prev, preset) {
        if (!ownAccounts().length) {
            toast('Cadastre uma conta antes de registrar lançamentos.');
            return;
        }
        const t = prev ? Object.assign({}, prev) : Object.assign({type: 'retirada', date: today(), tags: []}, preset || {});
        const descs = Array.from(new Set(C.txInRange(S, null, null).map((x) => x.description))).slice(0, 300);
        const body = `
            ${segmented('type', [['retirada', 'Despesa'], ['deposito', 'Receita'], ['transferencia', 'Transferência']], t.type)}
            <label class="big-amount"><span>R$</span>${inMoney('amount', t.amount != null ? t.amount : null, 'aria-label="Valor" required')}</label>
            <div class="group form">
                ${field('Descrição', inText('description', t.description || '', 'list="dl-desc" placeholder="Ex.: Mercado da semana" required'))}
                ${field('Data', inDate('date', t.date))}
                ${accountFields(t)}
            </div>
            <div class="group form">
                ${field('Categoria', inText('category', t.categoryId && S.categories[t.categoryId] ? S.categories[t.categoryId].name : '', 'list="dl-cat" placeholder="Nenhuma"'))}
                ${field('Orçamento', sel('budgetId', budgetOptions(), t.budgetId), {cls: 'only-retirada'})}
                ${field('Conta recorrente', sel('billId', billOptions(), t.billId), {cls: 'only-retirada'})}
                ${field('Tags', inText('tags', (t.tags || []).join(', '), 'placeholder="separadas por vírgula"'))}
                ${field('Notas', area('notes', t.notes))}
            </div>
            ${datalist('dl-desc', descs)}
            ${datalist('dl-cat', Object.values(S.categories).sort(byName).map((c) => c.name))}
            ${prev ? `<div class="btn-row"><button type="button" class="btn" data-dup>Duplicar</button><button type="button" class="btn danger" data-del>Apagar</button></div>
                ${prev.recurrenceId && S.recurrences[prev.recurrenceId] ? `<p class="muted small">Criado pela recorrência "${esc(S.recurrences[prev.recurrenceId].title)}".</p>` : ''}` : ''}`;
        openSheet({
            title: prev ? 'Editar lançamento' : 'Novo lançamento',
            body,
            init: (form, el) => {
                bindTypeSwitch(form);
                if (!prev) {
                    setTimeout(() => form.elements.amount.focus(), 250);
                    // Ao escolher uma descrição já usada, repete as contas e a categoria do último lançamento igual.
                    form.elements.description.addEventListener('change', () => {
                        const d = val(form, 'description').trim().toLocaleLowerCase('pt-BR');
                        const last = C.txInRange(S, null, null, (x) => x.description.toLocaleLowerCase('pt-BR') === d)[0];
                        if (!last) {
                            return;
                        }
                        $$('input[name="type"]', form).forEach((r) => {
                            r.checked = r.value === last.type;
                        });
                        form.dataset.type = last.type;
                        const set = (n, v) => {
                            if (form.elements[n] && v != null) {
                                form.elements[n].value = v;
                            }
                        };
                        if (last.type === 'retirada') {
                            set('d_src', last.source);
                            set('d_dst', accName(last.dest));
                            set('budgetId', last.budgetId || '');
                            set('billId', last.billId || '');
                        } else if (last.type === 'deposito') {
                            set('r_src', accName(last.source));
                            set('r_dst', last.dest);
                        } else {
                            set('t_src', last.source);
                            set('t_dst', last.dest);
                        }
                        if (last.categoryId && S.categories[last.categoryId] && !val(form, 'category')) {
                            set('category', S.categories[last.categoryId].name);
                        }
                        if (!val(form, 'amount')) {
                            set('amount', C.moneyToInput(last.amount));
                        }
                    });
                }
                if (prev) {
                    $('[data-del]', form).addEventListener('click', () => confirmSheet({
                        title: 'Apagar lançamento', message: `Apagar "${prev.description}" de ${C.fmtMoney(prev.amount)}? Isso não pode ser desfeito.`,
                        confirmLabel: 'Apagar lançamento', destructive: true,
                        onConfirm: () => {
                            const touched = new Set();
                            removeTx([prev.id], touched);
                            closeSheet(el);
                            commit(touched);
                            toast('Lançamento apagado.');
                        },
                    }));
                    $('[data-dup]', form).addEventListener('click', () => {
                        closeSheet(el);
                        const copy = Object.assign({}, prev, {date: today()});
                        delete copy.id;
                        delete copy.recurrenceId;
                        delete copy.createdAt;
                        txSheet(null, copy);
                    });
                }
            },
            onSubmit: (form) => {
                const type = val(form, 'type');
                const amount = C.parseMoney(val(form, 'amount'));
                if (!(amount > 0)) {
                    return 'Informe um valor maior que zero.';
                }
                if (!val(form, 'description').trim()) {
                    return 'Informe uma descrição.';
                }
                if (!C.isISODate(val(form, 'date'))) {
                    return 'Informe uma data válida.';
                }
                if (type === 'transferencia' && val(form, 't_src') === val(form, 't_dst')) {
                    return 'Escolha contas diferentes para a transferência.';
                }
                const touched = new Set();
                let n = Object.assign({}, prev || {}, {
                    id: prev ? prev.id : C.newId(), type, amount,
                    description: val(form, 'description'), date: val(form, 'date'),
                    categoryId: ensureCategory(val(form, 'category'), touched),
                    budgetId: val(form, 'budgetId') || null, billId: val(form, 'billId') || null,
                    tags: val(form, 'tags'), notes: val(form, 'notes'),
                    createdAt: prev ? prev.createdAt : nowISO(), updatedAt: nowISO(),
                }, readAccounts(form, type, touched));
                n = withRules(C.normalizeTx(S, n), prev ? 'editar' : 'criar', touched);
                const err = C.validateTx(S, n);
                if (err) {
                    return err;
                }
                putTx(n, prev, touched);
                commit(touched);
                toast(prev ? 'Lançamento atualizado.' : 'Lançamento salvo.');
                return true;
            },
        });
    }

    // Conta

    const OWN_KINDS = ['corrente', 'poupanca', 'dinheiro', 'investimento', 'cartao', 'emprestimo', 'divida', 'financiamento'];

    function accountSheet(prev, onboarding) {
        const own = !prev || C.isOwn(prev);
        const a = prev ? Object.assign({}, prev) : {kind: 'corrente', active: true, includeNetWorth: true, openingDate: today()};
        const debt = (k) => k === 'cartao' || C.ACCOUNT_KINDS[k].grupo === 'passivo';
        const opening = a.openingBalance != null ? (debt(a.kind) ? -a.openingBalance : a.openingBalance) : null;
        const body = own ? `
            <div class="group form">
                ${field('Nome', inText('name', a.name || (onboarding ? 'Conta corrente' : ''), 'placeholder="Ex.: Conta do banco" required'))}
                ${field('Tipo', sel('kind', OWN_KINDS.map((k) => [k, C.ACCOUNT_KINDS[k].label]), a.kind))}
                ${field('<span data-lbl-saldo>Saldo inicial</span>', inMoney('opening', opening))}
                ${field('Na data', inDate('openingDate', a.openingDate || today()))}
                ${field('Limite do cartão', inMoney('creditLimit', a.creditLimit), {id: 'fld-limite'})}
            </div>
            <p class="muted small" data-help-saldo></p>
            ${onboarding ? `<div class="group form">${sw('seedCats', 'Criar categorias sugeridas', true)}</div>` : `<div class="group form">
                ${sw('includeNetWorth', 'Incluir no patrimônio', a.includeNetWorth !== false)}
                ${sw('active', 'Ativa', a.active !== false)}
                ${field('Notas', area('notes', a.notes))}
            </div>`}
            ${prev ? '<div class="btn-row"><button type="button" class="btn danger" data-del>Apagar conta</button></div>' : ''}`
            : `<div class="group form">${field('Nome', inText('name', a.name, 'required'))}${sw('active', 'Ativa', a.active !== false)}${field('Notas', area('notes', a.notes))}</div>
               <div class="btn-row"><button type="button" class="btn danger" data-del>Apagar conta</button></div>`;
        openSheet({
            title: onboarding ? 'Sua primeira conta' : prev ? 'Editar conta' : 'Nova conta',
            body,
            submitLabel: onboarding ? 'Criar' : 'Salvar',
            init: (form, el) => {
                if (own) {
                    const sync = () => {
                        const k = val(form, 'kind');
                        $('[data-lbl-saldo]', form).textContent = debt(k) ? 'Valor devido' : 'Saldo inicial';
                        $('#fld-limite', form).hidden = k !== 'cartao';
                        $('[data-help-saldo]', form).textContent = debt(k)
                            ? 'Informe quanto você deve hoje. Pagamentos entram como transferência de outra conta para esta.'
                            : 'Informe o saldo que a conta tinha nessa data. Lançamentos a partir dela atualizam o saldo.';
                    };
                    form.elements.kind.addEventListener('change', sync);
                    sync();
                }
                const del = $('[data-del]', form);
                if (del) {
                    del.addEventListener('click', () => {
                        const txIds = Object.values(S.tx).filter((t) => t.source === prev.id || t.dest === prev.id).map((t) => t.id);
                        confirmSheet({
                            title: 'Apagar conta',
                            message: txIds.length
                                ? `A conta "${prev.name}" tem ${txIds.length} lançamento${txIds.length === 1 ? '' : 's'}. Apagar a conta apaga esses lançamentos também. Se quiser só escondê-la, desative-a.`
                                : `Apagar a conta "${prev.name}"?`,
                            confirmLabel: txIds.length ? 'Apagar conta e lançamentos' : 'Apagar conta', destructive: true,
                            onConfirm: () => {
                                const touched = new Set(['accounts']);
                                removeTx(txIds, touched);
                                delete S.accounts[prev.id];
                                for (const p of Object.values(S.piggies)) {
                                    if (p.accountId === prev.id) {
                                        delete S.piggies[p.id];
                                        touched.add('piggies');
                                    }
                                }
                                for (const r of Object.values(S.recurrences)) {
                                    if (r.source === prev.id || r.dest === prev.id) {
                                        S.recurrences[r.id] = Object.assign({}, r, {active: false});
                                        touched.add('recurrences');
                                    }
                                }
                                closeSheet(el);
                                ui.stack = ui.stack.filter((s) => s.id !== prev.id);
                                commit(touched);
                                toast('Conta apagada.');
                            },
                        });
                    });
                }
            },
            onSubmit: (form) => {
                const name = val(form, 'name').trim();
                if (!name) {
                    return 'Informe um nome para a conta.';
                }
                const kind = own ? val(form, 'kind') : a.kind;
                const clash = Object.values(S.accounts).find((x) => x.id !== a.id && C.groupOf(x) === C.ACCOUNT_KINDS[kind].grupo
                    && x.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'));
                if (clash) {
                    return 'Já existe uma conta com esse nome.';
                }
                const n = Object.assign({}, a, {id: a.id || C.newId(), name, kind, notes: val(form, 'notes'), updatedAt: nowISO()});
                if (!prev) {
                    n.createdAt = nowISO();
                }
                if (form.elements.active) {
                    n.active = checked(form, 'active');
                }
                if (own) {
                    const raw = val(form, 'opening').trim();
                    const v = raw ? C.parseMoney(raw) : 0;
                    if (Number.isNaN(v)) {
                        return 'O saldo inicial não é um valor válido.';
                    }
                    if (!C.isISODate(val(form, 'openingDate'))) {
                        return 'Informe a data do saldo inicial.';
                    }
                    n.openingBalance = debt(kind) ? -Math.abs(v) : v;
                    n.openingDate = val(form, 'openingDate');
                    const lim = C.parseMoney(val(form, 'creditLimit'));
                    n.creditLimit = kind === 'cartao' && lim > 0 ? lim : null;
                    if (form.elements.includeNetWorth) {
                        n.includeNetWorth = checked(form, 'includeNetWorth');
                    }
                }
                S.accounts[n.id] = n;
                const touched = new Set(['accounts']);
                if (onboarding && checked(form, 'seedCats')) {
                    for (const c of ['Alimentação', 'Moradia', 'Transporte', 'Saúde', 'Educação', 'Lazer', 'Compras', 'Contas da casa', 'Salário']) {
                        ensureCategory(c, touched);
                    }
                }
                commit(touched);
                toast(onboarding ? 'Pronto! Agora registre seus lançamentos pelo botão +.' : 'Conta salva.');
                return true;
            },
        });
    }

    // Categoria

    function categorySheet(prev) {
        openSheet({
            title: prev ? 'Editar categoria' : 'Nova categoria',
            body: `<div class="group form">${field('Nome', inText('name', prev ? prev.name : '', 'placeholder="Ex.: Alimentação" required'))}</div>
                ${prev ? '<div class="btn-row"><button type="button" class="btn danger" data-del>Apagar categoria</button></div><p class="muted small">Os lançamentos desta categoria ficam sem categoria.</p>' : ''}`,
            init: (form, el) => {
                if (prev) {
                    $('[data-del]', form).addEventListener('click', () => confirmSheet({
                        title: 'Apagar categoria', message: `Apagar a categoria "${prev.name}"?`, confirmLabel: 'Apagar categoria', destructive: true,
                        onConfirm: () => {
                            const touched = new Set(['categories']);
                            delete S.categories[prev.id];
                            unlinkTx('categoryId', prev.id, touched);
                            closeSheet(el);
                            ui.stack = ui.stack.filter((s) => s.id !== prev.id);
                            commit(touched);
                        },
                    }));
                }
            },
            onSubmit: (form) => {
                const name = val(form, 'name').trim();
                if (!name) {
                    return 'Informe um nome.';
                }
                if (Object.values(S.categories).some((c) => c.id !== (prev && prev.id) && c.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))) {
                    return 'Já existe uma categoria com esse nome.';
                }
                const c = Object.assign({}, prev || {id: C.newId(), createdAt: nowISO()}, {name});
                S.categories[c.id] = c;
                commit(new Set(['categories']));
                return true;
            },
        });
    }

    // Orçamento

    function budgetSheet(prev) {
        openSheet({
            title: prev ? 'Editar orçamento' : 'Novo orçamento',
            body: `<div class="group form">
                ${field('Nome', inText('name', prev ? prev.name : '', 'placeholder="Ex.: Mercado" required'))}
                ${field('Valor por mês', inMoney('defaultAmount', prev ? prev.defaultAmount : null))}
                ${prev ? sw('active', 'Ativo', prev.active !== false) : ''}
                </div><p class="muted small">O valor por mês vale para todos os meses. Você pode mudar o valor de um mês específico na tela do orçamento.</p>
                ${prev ? '<div class="btn-row"><button type="button" class="btn danger" data-del>Apagar orçamento</button></div>' : ''}`,
            init: (form, el) => {
                if (prev) {
                    $('[data-del]', form).addEventListener('click', () => confirmSheet({
                        title: 'Apagar orçamento', message: `Apagar o orçamento "${prev.name}"? Os lançamentos continuam, só sem orçamento.`,
                        confirmLabel: 'Apagar orçamento', destructive: true,
                        onConfirm: () => {
                            const touched = new Set(['budgets']);
                            delete S.budgets[prev.id];
                            unlinkTx('budgetId', prev.id, touched);
                            closeSheet(el);
                            ui.stack = ui.stack.filter((s) => s.id !== prev.id);
                            commit(touched);
                        },
                    }));
                }
            },
            onSubmit: (form) => {
                const name = val(form, 'name').trim();
                if (!name) {
                    return 'Informe um nome.';
                }
                const raw = val(form, 'defaultAmount').trim();
                const amt = raw ? C.parseMoney(raw) : null;
                if (raw && !(amt > 0)) {
                    return 'O valor por mês precisa ser maior que zero.';
                }
                const b = Object.assign({limits: {}, order: Object.keys(S.budgets).length}, prev || {id: C.newId(), createdAt: nowISO(), active: true},
                    {name, defaultAmount: amt});
                if (prev) {
                    b.active = checked(form, 'active');
                }
                S.budgets[b.id] = b;
                commit(new Set(['budgets']));
                return true;
            },
        });
    }

    function budgetLimitSheet(b) {
        const mk = ui.month;
        const cur = b.limits && b.limits[mk] != null ? b.limits[mk] : null;
        openSheet({
            title: 'Valor para ' + C.fmtMonth(mk),
            body: `<div class="group form">${field('Valor', inMoney('amount', cur, `placeholder="${b.defaultAmount != null ? esc(C.moneyToInput(b.defaultAmount)) : '0,00'}"`))}</div>
                <p class="muted small">${b.defaultAmount != null ? 'Deixe em branco para usar o valor padrão de ' + esc(C.fmtMoney(b.defaultAmount)) + '.' : 'Deixe em branco para ficar sem valor neste mês.'}</p>`,
            init: (form) => setTimeout(() => form.elements.amount.focus(), 250),
            onSubmit: (form) => {
                const raw = val(form, 'amount').trim();
                const limits = Object.assign({}, b.limits || {});
                if (raw) {
                    const v = C.parseMoney(raw);
                    if (!(v >= 0)) {
                        return 'Informe um valor válido.';
                    }
                    limits[mk] = v;
                } else {
                    delete limits[mk];
                }
                S.budgets[b.id] = Object.assign({}, b, {limits});
                commit(new Set(['budgets']));
                return true;
            },
        });
    }

    // Conta recorrente

    function billSheet(prev) {
        const b = prev ? Object.assign({}, prev) : {repeatFreq: 'mensal', skip: 0, date: today(), active: true};
        openSheet({
            title: prev ? 'Editar conta recorrente' : 'Nova conta recorrente',
            body: `<div class="group form">
                ${field('Nome', inText('name', b.name || '', 'placeholder="Ex.: Aluguel" required'))}
                ${field('Valor mínimo', inMoney('amountMin', b.amountMin))}
                ${field('Valor máximo', inMoney('amountMax', b.amountMax, 'placeholder="igual ao mínimo"'))}
                ${field('Primeiro vencimento', inDate('date', b.date))}
                ${field('Frequência', sel('repeatFreq', Object.entries(C.BILL_FREQ).map(([k, f]) => [k, f.label]), b.repeatFreq))}
                ${field('Repetir', sel('skip', [[0, 'Todo período'], [1, 'A cada 2 períodos'], [2, 'A cada 3 períodos'], [3, 'A cada 4 períodos'], [5, 'A cada 6 períodos']], b.skip))}
                ${field('Termina em', inDate('endDate', b.endDate))}
                ${prev ? sw('active', 'Ativa', b.active !== false) : ''}
                ${field('Notas', area('notes', b.notes))}
            </div>
            ${prev ? '<div class="btn-row"><button type="button" class="btn danger" data-del>Apagar conta recorrente</button></div>'
                : `<div class="group form">${sw('mkRule', 'Vincular lançamentos sozinho', true)}</div>
                   <p class="muted small">Cria uma regra: despesas cuja descrição contém o nome desta conta, com valor dentro da faixa, ficam vinculadas a ela.</p>`}`,
            init: (form, el) => {
                if (prev) {
                    $('[data-del]', form).addEventListener('click', () => confirmSheet({
                        title: 'Apagar conta recorrente', message: `Apagar "${prev.name}"? Os lançamentos continuam, só sem vínculo.`,
                        confirmLabel: 'Apagar', destructive: true,
                        onConfirm: () => {
                            const touched = new Set(['bills']);
                            delete S.bills[prev.id];
                            unlinkTx('billId', prev.id, touched);
                            closeSheet(el);
                            ui.stack = ui.stack.filter((s) => s.id !== prev.id);
                            commit(touched);
                        },
                    }));
                }
            },
            onSubmit: (form) => {
                const name = val(form, 'name').trim();
                const min = C.parseMoney(val(form, 'amountMin'));
                const maxRaw = val(form, 'amountMax').trim();
                const max = maxRaw ? C.parseMoney(maxRaw) : min;
                if (!name) {
                    return 'Informe um nome.';
                }
                if (!(min > 0)) {
                    return 'Informe o valor mínimo.';
                }
                if (!(max >= min)) {
                    return 'O valor máximo precisa ser maior ou igual ao mínimo.';
                }
                if (!C.isISODate(val(form, 'date'))) {
                    return 'Informe a data do primeiro vencimento.';
                }
                const end = val(form, 'endDate');
                if (end && (!C.isISODate(end) || end < val(form, 'date'))) {
                    return 'A data final precisa ser depois do primeiro vencimento.';
                }
                const n = Object.assign({}, b, {
                    id: b.id || C.newId(), name, amountMin: min, amountMax: max, date: val(form, 'date'),
                    repeatFreq: val(form, 'repeatFreq'), skip: +val(form, 'skip') || 0, endDate: end || null,
                    notes: val(form, 'notes'), updatedAt: nowISO(),
                });
                if (prev) {
                    n.active = checked(form, 'active');
                } else {
                    n.createdAt = nowISO();
                }
                S.bills[n.id] = n;
                const touched = new Set(['bills']);
                if (!prev && checked(form, 'mkRule')) {
                    const r = {
                        id: C.newId(), title: 'Conta recorrente: ' + name, active: true, strict: true, onUpdate: true,
                        order: Object.keys(S.rules).length + 1, stopProcessing: false, createdAt: nowISO(),
                        triggers: [{type: 'tipo_e', value: 'retirada'}, {type: 'descricao_contem', value: name},
                            {type: 'valor_maior', value: Math.max(0, Math.floor(min * 0.95) - 1)}, {type: 'valor_menor', value: Math.ceil(max * 1.05) + 1}],
                        actions: [{type: 'vincular_conta_recorrente', value: n.id}],
                    };
                    S.rules[r.id] = r;
                    touched.add('rules');
                }
                commit(touched);
                return true;
            },
        });
    }

    // Recorrência

    function recurrenceSheet(prev) {
        if (!ownAccounts().length) {
            toast('Cadastre uma conta antes.');
            return;
        }
        const r = prev ? Object.assign({}, prev) : {type: 'retirada', repeatFreq: 'mensal', skip: 0, firstDate: C.addDays(today(), 1), active: true, applyRules: true, tags: []};
        const endMode = r.repetitions ? 'vezes' : r.endDate ? 'data' : 'nunca';
        openSheet({
            title: prev ? 'Editar recorrência' : 'Nova recorrência',
            body: `${segmented('type', [['retirada', 'Despesa'], ['deposito', 'Receita'], ['transferencia', 'Transferência']], r.type)}
                <div class="group form">
                    ${field('Título', inText('title', r.title || '', 'placeholder="Ex.: Salário" required'))}
                    ${field('Valor', inMoney('amount', r.amount))}
                    ${accountFields(r)}
                </div>
                <div class="group form">
                    ${field(prev ? 'Começou em' : 'Primeira data', inDate('firstDate', r.firstDate), prev ? {} : {})}
                    ${field('Frequência', sel('repeatFreq', Object.entries(C.REC_FREQ).map(([k, f]) => [k, f.label]), r.repeatFreq))}
                    ${field('Repetir', sel('skip', [[0, 'Todo período'], [1, 'A cada 2'], [2, 'A cada 3'], [3, 'A cada 4'], [5, 'A cada 6']], r.skip))}
                    ${field('Termina', sel('endMode', [['nunca', 'Nunca'], ['data', 'Numa data'], ['vezes', 'Depois de N vezes']], endMode))}
                    ${field('Data final', inDate('endDate', r.endDate), {cls: 'only-end-data'})}
                    ${field('Número de vezes', inText('repetitions', r.repetitions || '', 'inputmode="numeric"'), {cls: 'only-end-vezes'})}
                </div>
                <div class="group form">
                    ${field('Descrição do lançamento', inText('description', r.description || '', 'placeholder="igual ao título"'))}
                    ${field('Categoria', inText('category', r.categoryId && S.categories[r.categoryId] ? S.categories[r.categoryId].name : '', 'list="dl-cat2" placeholder="Nenhuma"'))}
                    ${field('Orçamento', sel('budgetId', budgetOptions(), r.budgetId), {cls: 'only-retirada'})}
                    ${field('Conta recorrente', sel('billId', billOptions(), r.billId), {cls: 'only-retirada'})}
                    ${field('Tags', inText('tags', (r.tags || []).join(', '), 'placeholder="separadas por vírgula"'))}
                    ${sw('applyRules', 'Aplicar regras', r.applyRules !== false)}
                    ${sw('active', 'Ativa', r.active !== false)}
                </div>
                ${datalist('dl-cat2', Object.values(S.categories).sort(byName).map((c) => c.name))}
                ${prev ? `<p class="muted small">${r.lastCreated ? 'Último lançamento criado em ' + esc(C.fmtDate(r.lastCreated)) + '.' : 'Nenhum lançamento criado ainda.'}</p>
                    <div class="btn-row"><button type="button" class="btn danger" data-del>Apagar recorrência</button></div>` : '<p class="muted small">A primeira data precisa ser hoje ou depois. Os lançamentos são criados quando você abre o app na data.</p>'}`,
            init: (form, el) => {
                bindTypeSwitch(form);
                const syncEnd = () => {
                    form.dataset.end = val(form, 'endMode');
                };
                form.elements.endMode.addEventListener('change', syncEnd);
                syncEnd();
                if (prev) {
                    $('[data-del]', form).addEventListener('click', () => confirmSheet({
                        title: 'Apagar recorrência', message: `Apagar "${prev.title}"? Os lançamentos já criados continuam.`,
                        confirmLabel: 'Apagar recorrência', destructive: true,
                        onConfirm: () => {
                            delete S.recurrences[prev.id];
                            closeSheet(el);
                            commit(new Set(['recurrences']));
                        },
                    }));
                }
            },
            onSubmit: (form) => {
                const type = val(form, 'type');
                const title = val(form, 'title').trim();
                const amount = C.parseMoney(val(form, 'amount'));
                const first = val(form, 'firstDate');
                if (!title) {
                    return 'Informe um título.';
                }
                if (!(amount > 0)) {
                    return 'Informe um valor maior que zero.';
                }
                if (!C.isISODate(first)) {
                    return 'Informe a primeira data.';
                }
                if (!prev && first < today()) {
                    return 'A primeira data precisa ser hoje ou depois.';
                }
                if (type === 'transferencia' && val(form, 't_src') === val(form, 't_dst')) {
                    return 'Escolha contas diferentes para a transferência.';
                }
                const endMode = val(form, 'endMode');
                const reps = parseInt(val(form, 'repetitions'), 10);
                if (endMode === 'vezes' && !(reps > 0)) {
                    return 'Informe quantas vezes a recorrência acontece.';
                }
                if (endMode === 'data' && (!C.isISODate(val(form, 'endDate')) || val(form, 'endDate') < first)) {
                    return 'A data final precisa ser depois da primeira data.';
                }
                const touched = new Set(['recurrences']);
                const n = Object.assign({}, r, {
                    id: r.id || C.newId(), type, title, amount, firstDate: first,
                    repeatFreq: val(form, 'repeatFreq'), skip: +val(form, 'skip') || 0,
                    endDate: endMode === 'data' ? val(form, 'endDate') : null,
                    repetitions: endMode === 'vezes' ? reps : null,
                    description: val(form, 'description').trim(),
                    categoryId: ensureCategory(val(form, 'category'), touched),
                    budgetId: type === 'retirada' ? val(form, 'budgetId') || null : null,
                    billId: type === 'retirada' ? val(form, 'billId') || null : null,
                    tags: C.cleanTags(val(form, 'tags')),
                    applyRules: checked(form, 'applyRules'), active: checked(form, 'active'), updatedAt: nowISO(),
                }, readAccounts(form, type, touched));
                const err = C.validateTx(S, {description: title, amount, date: first, source: n.source, dest: n.dest});
                if (err) {
                    return err;
                }
                if (!prev) {
                    n.createdAt = nowISO();
                }
                S.recurrences[n.id] = n;
                commit(touched);
                runRecurrences();
                return true;
            },
        });
    }

    // Cofrinho

    function piggySheet(prev) {
        const assets = ownAccounts().filter((a) => C.groupOf(a) === 'ativo' && a.kind !== 'cartao');
        if (!assets.length) {
            toast('Cadastre uma conta corrente ou poupança antes.');
            return;
        }
        const p = prev ? Object.assign({}, prev) : {accountId: (assets.find((a) => a.kind === 'poupanca') || assets[0]).id, active: true, startDate: today()};
        openSheet({
            title: prev ? 'Editar cofrinho' : 'Novo cofrinho',
            body: `<div class="group form">
                ${field('Nome', inText('name', p.name || '', 'placeholder="Ex.: Viagem de férias" required'))}
                ${field('Meta', inMoney('target', p.target))}
                ${field('Conta', sel('accountId', assets.map((a) => [a.id, a.name]), p.accountId))}
                ${field('Data alvo', inDate('targetDate', p.targetDate))}
                ${prev ? sw('active', 'Ativo', p.active !== false) : ''}
                ${field('Notas', area('notes', p.notes))}
            </div>
            <p class="muted small">O dinheiro do cofrinho continua na conta escolhida. O Vagalume só separa quanto dele é para essa meta.</p>
            ${prev ? '<div class="btn-row"><button type="button" class="btn danger" data-del>Apagar cofrinho</button></div>' : ''}`,
            init: (form, el) => {
                if (prev) {
                    $('[data-del]', form).addEventListener('click', () => confirmSheet({
                        title: 'Apagar cofrinho', message: `Apagar o cofrinho "${prev.name}"? O dinheiro continua na conta.`,
                        confirmLabel: 'Apagar cofrinho', destructive: true,
                        onConfirm: () => {
                            delete S.piggies[prev.id];
                            closeSheet(el);
                            ui.stack = ui.stack.filter((s) => s.id !== prev.id);
                            commit(new Set(['piggies']));
                        },
                    }));
                }
            },
            onSubmit: (form) => {
                const name = val(form, 'name').trim();
                const target = C.parseMoney(val(form, 'target'));
                const td = val(form, 'targetDate');
                if (!name) {
                    return 'Informe um nome.';
                }
                if (!(target > 0)) {
                    return 'Informe a meta.';
                }
                if (td && !C.isISODate(td)) {
                    return 'A data alvo não é válida.';
                }
                const n = Object.assign({events: []}, p, {
                    id: p.id || C.newId(), name, target, accountId: val(form, 'accountId'), targetDate: td || null,
                    notes: val(form, 'notes'), updatedAt: nowISO(),
                });
                if (prev) {
                    n.active = checked(form, 'active');
                } else {
                    n.createdAt = nowISO();
                }
                S.piggies[n.id] = n;
                commit(new Set(['piggies']));
                return true;
            },
        });
    }

    function piggyMoveSheet(p, sign) {
        const info = C.piggyInfo(p);
        openSheet({
            title: sign > 0 ? 'Guardar no cofrinho' : 'Retirar do cofrinho',
            body: `<label class="big-amount"><span>R$</span>${inMoney('amount', null, 'aria-label="Valor"')}</label>
                <div class="group form">${field('Data', inDate('date', today()))}${field('Nota', inText('note', '', 'placeholder="opcional"'))}</div>
                <p class="muted small">${sign > 0 ? 'Falta ' + esc(C.fmtMoney(info.left)) + ' para a meta.' : 'Guardado: ' + esc(C.fmtMoney(info.saved)) + '.'}</p>`,
            init: (form) => setTimeout(() => form.elements.amount.focus(), 250),
            onSubmit: (form) => {
                const v = C.parseMoney(val(form, 'amount'));
                if (!(v > 0)) {
                    return 'Informe um valor maior que zero.';
                }
                if (sign < 0 && v > info.saved) {
                    return 'Você só pode retirar até ' + C.fmtMoney(info.saved) + '.';
                }
                if (!C.isISODate(val(form, 'date'))) {
                    return 'Informe uma data válida.';
                }
                const events = (p.events || []).concat([{date: val(form, 'date'), amount: sign * v, note: val(form, 'note').trim()}]);
                S.piggies[p.id] = Object.assign({}, p, {events});
                commit(new Set(['piggies']));
                if (sign > 0 && info.saved + v >= info.target) {
                    toast('Meta atingida! 🎉');
                }
                return true;
            },
        });
    }

    // Regra

    function ruleValueInput(kind, input, name, value) {
        switch (input) {
            case null:
            case undefined:
                return '';
            case 'valor':
                return inMoney(name, value != null && value !== '' ? +value : null);
            case 'tipo':
                return sel(name, Object.entries(C.TX_TYPES).map(([k, t]) => [k, t.label]), value);
            case 'categoria':
                return sel(name, Object.values(S.categories).sort(byName).map((c) => [c.id, c.name]), value);
            case 'orcamento':
                return sel(name, Object.values(S.budgets).sort(byName).map((b) => [b.id, b.name]), value);
            case 'conta_recorrente':
                return sel(name, Object.values(S.bills).sort(byName).map((b) => [b.id, b.name]), value);
            default:
                return inText(name, value || '', `placeholder="${kind === 'acao' ? 'valor' : 'texto'}"`);
        }
    }

    function ruleRow(kind, i, item) {
        const table = kind === 'cond' ? C.RULE_TRIGGERS : C.RULE_ACTIONS;
        const def = table[item.type] || {};
        return `<div class="rule-line" data-kind="${kind}" data-i="${i}">
            ${sel(`${kind}_type_${i}`, Object.entries(table).map(([k, d]) => [k, d.label]), item.type, 'data-rtype aria-label="Tipo"')}
            <span class="rule-val">${ruleValueInput(kind === 'cond' ? 'cond' : 'acao', def.input, `${kind}_val_${i}`, item.value)}</span>
            <button type="button" class="icon-btn del" data-rm aria-label="Remover">×</button></div>`;
    }

    function readRuleItems(form, kind) {
        const table = kind === 'cond' ? C.RULE_TRIGGERS : C.RULE_ACTIONS;
        return $$(`.rule-line[data-kind="${kind}"]`, form).map((line) => {
            const i = line.dataset.i;
            const type = val(form, `${kind}_type_${i}`);
            const def = table[type];
            let value = def && def.input ? val(form, `${kind}_val_${i}`) : null;
            if (def && def.input === 'valor') {
                value = C.parseMoney(value);
            }
            return {type, value};
        });
    }

    function ruleSheet(prev) {
        const r = prev ? clone(prev) : {
            active: true, strict: true, onUpdate: false, stopProcessing: false,
            triggers: [{type: 'descricao_contem', value: ''}], actions: [{type: 'definir_categoria', value: ''}],
        };
        let seq = 100;
        openSheet({
            title: prev ? 'Editar regra' : 'Nova regra',
            body: `<div class="group form">
                ${field('Nome', inText('title', r.title || '', 'placeholder="Ex.: Corridas de app" required'))}
                ${sw('active', 'Ativa', r.active !== false)}
                ${sw('onUpdate', 'Rodar também ao editar', !!r.onUpdate)}
                ${sw('stopProcessing', 'Parar as regras seguintes', !!r.stopProcessing)}
            </div>
            <h3 class="form-h">Quando</h3>
            ${segmented('strict', [['todas', 'Todas as condições'], ['qualquer', 'Qualquer condição']], r.strict === false ? 'qualquer' : 'todas')}
            <div class="group pad" data-list="cond">${(r.triggers || []).map((x, i) => ruleRow('cond', i, x)).join('')}</div>
            <button type="button" class="btn plain" data-add="cond">+ Adicionar condição</button>
            <h3 class="form-h">Então</h3>
            <div class="group pad" data-list="acao">${(r.actions || []).map((x, i) => ruleRow('acao', i, x)).join('')}</div>
            <button type="button" class="btn plain" data-add="acao">+ Adicionar ação</button>
            ${prev ? `<div class="btn-row"><button type="button" class="btn" data-apply>Aplicar aos lançamentos</button><button type="button" class="btn danger" data-del>Apagar</button></div>` : ''}`,
            init: (form, el) => {
                form.addEventListener('change', (e) => {
                    if (e.target.matches('[data-rtype]')) {
                        const line = e.target.closest('.rule-line');
                        const kind = line.dataset.kind;
                        const def = (kind === 'cond' ? C.RULE_TRIGGERS : C.RULE_ACTIONS)[e.target.value];
                        $('.rule-val', line).innerHTML = ruleValueInput(kind, def.input, `${kind}_val_${line.dataset.i}`, '');
                    }
                });
                form.addEventListener('click', (e) => {
                    const rm = e.target.closest('[data-rm]');
                    if (rm) {
                        rm.closest('.rule-line').remove();
                    }
                    const add = e.target.closest('[data-add]');
                    if (add) {
                        const kind = add.dataset.add;
                        const item = kind === 'cond' ? {type: 'descricao_contem', value: ''} : {type: 'definir_categoria', value: ''};
                        $(`[data-list="${kind}"]`, form).insertAdjacentHTML('beforeend', ruleRow(kind, seq++, item));
                    }
                });
                if (prev) {
                    $('[data-del]', form).addEventListener('click', () => confirmSheet({
                        title: 'Apagar regra', message: `Apagar a regra "${prev.title}"?`, confirmLabel: 'Apagar regra', destructive: true,
                        onConfirm: () => {
                            delete S.rules[prev.id];
                            closeSheet(el);
                            commit(new Set(['rules']));
                        },
                    }));
                    $('[data-apply]', form).addEventListener('click', () => applyRuleSheet(S.rules[prev.id] || prev));
                }
            },
            onSubmit: (form) => {
                const title = val(form, 'title').trim();
                const triggers = readRuleItems(form, 'cond');
                const actions = readRuleItems(form, 'acao');
                if (!title) {
                    return 'Dê um nome para a regra.';
                }
                if (!triggers.length) {
                    return 'Adicione pelo menos uma condição.';
                }
                if (!actions.length) {
                    return 'Adicione pelo menos uma ação.';
                }
                for (const x of triggers) {
                    const d = C.RULE_TRIGGERS[x.type];
                    if (d.input && (x.value === '' || x.value == null || Number.isNaN(x.value))) {
                        return `Preencha o valor da condição "${d.label}".`;
                    }
                }
                for (const x of actions) {
                    const d = C.RULE_ACTIONS[x.type];
                    if (d.input && d.input !== 'texto' && !x.value) {
                        return `Escolha o valor da ação "${d.label}".`;
                    }
                }
                const n = Object.assign({}, r, {
                    id: r.id || C.newId(), title, triggers, actions,
                    active: checked(form, 'active'), onUpdate: checked(form, 'onUpdate'), stopProcessing: checked(form, 'stopProcessing'),
                    strict: val(form, 'strict') !== 'qualquer', updatedAt: nowISO(),
                });
                if (!prev) {
                    n.createdAt = nowISO();
                    n.order = Object.keys(S.rules).length + 1;
                }
                S.rules[n.id] = n;
                commit(new Set(['rules']));
                toast(prev ? 'Regra atualizada.' : 'Regra criada. Ela roda nos próximos lançamentos.');
                return true;
            },
        });
    }

    function applyRuleSheet(rule) {
        const y = today().slice(0, 4);
        openSheet({
            title: 'Aplicar regra',
            body: `<p class="confirm-text">Aplicar "${esc(rule.title)}" aos lançamentos que já existem. Salve a regra antes, se mudou algo.</p>
                <div class="group form">${field('Quais lançamentos', sel('range', [['ano', 'Deste ano (' + y + ')'], ['todos', 'Todos']], 'ano'))}</div>`,
            submitLabel: 'Aplicar',
            onSubmit: (form) => {
                const from = val(form, 'range') === 'ano' ? y + '-01-01' : null;
                const touched = new Set();
                const ctx = ruleCtx(touched);
                let changed = 0;
                for (const t of C.txInRange(S, from, null)) {
                    if (!C.ruleMatches(rule, t, ctx)) {
                        continue;
                    }
                    const res = C.applyRules(S, t, ctx, {only: rule});
                    const n = C.normalizeTx(S, res.tx);
                    if (JSON.stringify(n) !== JSON.stringify(t) && !C.validateTx(S, n)) {
                        putTx(n, t, touched);
                        changed++;
                    }
                }
                commit(touched);
                toast(changed ? `${changed} lançamento${changed === 1 ? '' : 's'} alterado${changed === 1 ? '' : 's'}.` : 'Nenhum lançamento precisou mudar.');
                return true;
            },
        });
    }

    // ----------------------------------------------------------------- backup

    async function exportBackup() {
        const json = JSON.stringify(C.exportData(S), null, 1);
        const name = 'vagalume-backup-' + today() + '.json';
        if (store.downloads === undefined) {
            store.downloads = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
        }
        if (!store.downloads) {
            toast('Esta visualização não permite salvar arquivos. Abra o app no claude.ai.');
            return;
        }
        try {
            await store.downloads.save({filename: name, data: json});
            toast('Backup salvo.');
        } catch (e) {
            if (e && e.code !== 'declined') {
                toast('Não foi possível salvar o backup agora.');
            }
        }
    }

    function importFile(file) {
        const reader = new FileReader();
        reader.onload = () => {
            let next;
            try {
                next = C.importData(String(reader.result));
            } catch (e) {
                toast(e instanceof SyntaxError ? 'O arquivo não é um JSON válido.' : e.message);
                return;
            }
            const n = Object.keys(next.tx).length;
            confirmSheet({
                title: 'Restaurar backup',
                message: `O backup tem ${Object.keys(next.accounts).length} contas e ${n} lançamentos. Restaurar substitui todos os dados atuais. Continuar?`,
                confirmLabel: 'Substituir meus dados', destructive: true,
                onConfirm: () => replaceAll(next, 'Backup restaurado.'),
            });
        };
        reader.readAsText(file);
    }

    function replaceAll(next, msg) {
        const before = monthsInState();
        S = next;
        const after = monthsInState();
        commit(new Set(DOCS.concat(Array.from(before), Array.from(after))));
        tab('painel');
        toast(msg);
    }

    // -------------------------------------------------------------- eventos

    const ACTIONS = {
        voltar: () => {
            if (ui.stack.length > 1) {
                ui.stack.pop();
                render();
            }
        },
        periodo: (d) => {
            const step = +d.d;
            if (d.key === 'reportYear') {
                ui.reportYear += step;
            } else {
                ui[d.key] = C.shiftMonth(ui[d.key], step);
            }
            render();
        },
        'periodo-hoje': (d) => {
            if (d.key === 'reportYear') {
                ui.reportYear = +today().slice(0, 4);
            } else {
                ui[d.key] = C.monthKey(today());
            }
            render();
        },
        'filtro-tx': (d) => {
            ui.txFilter = d.v;
            render();
        },
        'aba-contas': (d) => {
            ui.accTab = d.v;
            render();
        },
        'modo-relatorio': (d) => {
            ui.reportMode = d.v;
            render();
        },
        comecar: () => accountSheet(null, true),
        'novo-lancamento': () => txSheet(null),
        'editar-lancamento': (d) => S.tx[d.id] && txSheet(S.tx[d.id]),
        'nova-conta': () => accountSheet(null),
        'editar-conta': (d) => S.accounts[d.id] && accountSheet(S.accounts[d.id]),
        'nova-categoria': () => categorySheet(null),
        'editar-categoria': (d) => S.categories[d.id] && categorySheet(S.categories[d.id]),
        'novo-orcamento': () => budgetSheet(null),
        'editar-orcamento': (d) => S.budgets[d.id] && budgetSheet(S.budgets[d.id]),
        'limite-orcamento': (d) => S.budgets[d.id] && budgetLimitSheet(S.budgets[d.id]),
        'nova-conta-recorrente': () => billSheet(null),
        'editar-conta-recorrente': (d) => S.bills[d.id] && billSheet(S.bills[d.id]),
        'nova-recorrencia': () => recurrenceSheet(null),
        'editar-recorrencia': (d) => S.recurrences[d.id] && recurrenceSheet(S.recurrences[d.id]),
        'novo-cofrinho': () => piggySheet(null),
        'editar-cofrinho': (d) => S.piggies[d.id] && piggySheet(S.piggies[d.id]),
        'cofrinho-mov': (d) => S.piggies[d.id] && piggyMoveSheet(S.piggies[d.id], +d.sign),
        'cofrinho-apagar-mov': (d) => {
            const p = S.piggies[d.id];
            const e = p && p.events[+d.idx];
            if (!e) {
                return;
            }
            confirmSheet({
                title: 'Apagar movimento', message: `Apagar o movimento de ${C.fmtMoney(Math.abs(e.amount))} de ${C.fmtDate(e.date)}?`,
                confirmLabel: 'Apagar movimento', destructive: true,
                onConfirm: () => {
                    S.piggies[p.id] = Object.assign({}, p, {events: p.events.filter((_, i) => i !== +d.idx)});
                    commit(new Set(['piggies']));
                },
            });
        },
        'nova-regra': () => ruleSheet(null),
        'editar-regra': (d) => S.rules[d.id] && ruleSheet(S.rules[d.id]),
        exportar: () => exportBackup(),
        'apagar-tudo': () => confirmSheet({
            title: 'Apagar todos os dados',
            message: 'Isso apaga todas as contas, lançamentos e cadastros deste app. Faça um backup antes se quiser guardar alguma coisa. Não pode ser desfeito.',
            confirmLabel: 'Apagar tudo', destructive: true,
            onConfirm: () => replaceAll(C.emptyState(), 'Todos os dados foram apagados.'),
        }),
    };

    document.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('[data-tab]');
        if (tabBtn) {
            tab(tabBtn.dataset.tab);
            return;
        }
        const goEl = e.target.closest('[data-go]');
        if (goEl) {
            const view = goEl.dataset.go;
            if (view === 'categoria-rel') {
                ui.month = ui.reportMonth;
                go('categoria', {id: goEl.dataset.id});
            } else {
                go(view, goEl.dataset.id ? {id: goEl.dataset.id} : null);
            }
            return;
        }
        const actEl = e.target.closest('[data-act]');
        if (actEl && ACTIONS[actEl.dataset.act]) {
            ACTIONS[actEl.dataset.act](actEl.dataset, actEl);
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sheets.length) {
            closeSheet(sheets[sheets.length - 1]);
        }
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => drawCharts($('#main')), 150);
    });

    // ---------------------------------------------------- dados de exemplo
    // Usados só quando o banco do Claude não está disponível (fora do claude.ai).

    function demoState() {
        const s = C.emptyState();
        const t = today();
        const mk = C.monthKey(t);
        let seed = 7;
        const rnd = () => {
            seed = (seed * 9301 + 49297) % 233280;
            return seed / 233280;
        };
        const acc = (name, kind, extra) => {
            const a = Object.assign({id: C.newId(), name, kind, active: true, createdAt: nowISO()}, extra || {});
            s.accounts[a.id] = a;
            return a.id;
        };
        const start = C.shiftMonth(mk, -5) + '-01';
        const cc = acc('Conta corrente', 'corrente', {openingBalance: 420000, openingDate: start});
        const poup = acc('Poupança', 'poupanca', {openingBalance: 1500000, openingDate: start});
        const card = acc('Cartão de crédito', 'cartao', {openingBalance: 0, openingDate: start, creditLimit: 800000});
        acc('Financiamento do carro', 'financiamento', {openingBalance: -2400000, openingDate: start});
        const exp = {};
        for (const n of ['Supermercado', 'Padaria', 'Posto de combustível', 'Farmácia', 'Restaurante', 'Imobiliária', 'Companhia de energia', 'Provedor de internet', 'Uber', 'Cinema']) {
            exp[n] = acc(n, 'despesa');
        }
        const emp = acc('Empresa', 'receita');
        const free = acc('Clientes de freelance', 'receita');
        const cat = {};
        for (const n of ['Alimentação', 'Moradia', 'Transporte', 'Saúde', 'Lazer', 'Contas da casa', 'Salário']) {
            const c = {id: C.newId(), name: n};
            s.categories[c.id] = c;
            cat[n] = c.id;
        }
        const bud = {};
        for (const [n, v] of [['Mercado', 140000], ['Lazer', 50000], ['Transporte', 60000]]) {
            const b = {id: C.newId(), name: n, defaultAmount: v, limits: {}, active: true, order: Object.keys(s.budgets).length};
            s.budgets[b.id] = b;
            bud[n] = b.id;
        }
        const bill = (name, min, max, day) => {
            const b = {id: C.newId(), name, amountMin: min, amountMax: max, date: C.addMonths(start, 0, day), repeatFreq: 'mensal', skip: 0, active: true};
            s.bills[b.id] = b;
            return b.id;
        };
        const bAluguel = bill('Aluguel', 180000, 180000, 5);
        const bLuz = bill('Energia elétrica', 15000, 26000, 15);
        const bNet = bill('Internet', 9990, 9990, 20);
        const add = (date, src, dst, amount, desc, extra) => {
            if (date > t) {
                return;
            }
            const x = C.normalizeTx(s, Object.assign({id: C.newId(), date, source: src, dest: dst, amount, description: desc, createdAt: date + 'T12:00:00Z'}, extra || {}));
            s.tx[x.id] = x;
        };
        for (let i = 5; i >= 0; i--) {
            const m = C.shiftMonth(mk, -i);
            const d = (day) => C.addMonths(m + '-01', 0, day);
            add(d(5), emp, cc, 750000, 'Salário', {categoryId: cat['Salário']});
            if (i % 2 === 0) {
                add(d(18), free, cc, 120000 + Math.round(rnd() * 80000), 'Projeto de site', {categoryId: cat['Salário'], tags: ['freelance']});
            }
            add(d(5), cc, exp['Imobiliária'], 180000, 'Aluguel', {categoryId: cat['Moradia'], billId: bAluguel});
            add(d(15), cc, exp['Companhia de energia'], 15000 + Math.round(rnd() * 9000), 'Conta de luz', {categoryId: cat['Contas da casa'], billId: bLuz});
            add(d(20), cc, exp['Provedor de internet'], 9990, 'Internet', {categoryId: cat['Contas da casa'], billId: bNet});
            add(d(6), cc, poup, 50000, 'Reserva do mês');
            add(d(10), cc, card, 150000 + Math.round(rnd() * 60000), 'Pagamento da fatura');
            for (const day of [3, 9, 16, 23, 29]) {
                add(d(day), card, exp['Supermercado'], 18000 + Math.round(rnd() * 22000), 'Compras do mês', {categoryId: cat['Alimentação'], budgetId: bud['Mercado']});
            }
            for (const day of [2, 7, 12, 19, 26]) {
                add(d(day), cc, exp['Padaria'], 1500 + Math.round(rnd() * 2500), 'Padaria', {categoryId: cat['Alimentação'], budgetId: bud['Mercado']});
            }
            for (const day of [8, 22]) {
                add(d(day), card, exp['Posto de combustível'], 20000 + Math.round(rnd() * 8000), 'Gasolina', {categoryId: cat['Transporte'], budgetId: bud['Transporte']});
            }
            for (const day of [4, 13, 21, 27]) {
                add(d(day), card, exp['Uber'], 1800 + Math.round(rnd() * 3000), 'Uber', {categoryId: cat['Transporte'], budgetId: bud['Transporte']});
            }
            add(d(14), card, exp['Restaurante'], 9000 + Math.round(rnd() * 9000), 'Jantar fora', {categoryId: cat['Lazer'], budgetId: bud['Lazer']});
            add(d(24), card, exp['Cinema'], 6000, 'Cinema', {categoryId: cat['Lazer'], budgetId: bud['Lazer']});
            if (rnd() > 0.5) {
                add(d(11), cc, exp['Farmácia'], 4000 + Math.round(rnd() * 8000), 'Farmácia', {categoryId: cat['Saúde']});
            }
        }
        const rec = {
            id: C.newId(), title: 'Salário', type: 'deposito', amount: 750000, source: emp, dest: cc, categoryId: cat['Salário'],
            firstDate: C.addMonths(start, 0, 5), repeatFreq: 'mensal', skip: 0, active: true, applyRules: false, tags: [],
            lastCreated: C.monthKey(t) + '-05' <= t ? C.monthKey(t) + '-05' : C.shiftMonth(mk, -1) + '-05',
        };
        s.recurrences[rec.id] = rec;
        const pig = {
            id: C.newId(), name: 'Viagem de férias', accountId: poup, target: 600000, targetDate: C.addMonths(t, 8), active: true,
            events: [{date: start, amount: 150000, note: ''}, {date: C.addMonths(start, 2), amount: 100000, note: '13º adiantado'}],
        };
        s.piggies[pig.id] = pig;
        const pig2 = {id: C.newId(), name: 'Reserva de emergência', accountId: poup, target: 2400000, active: true, events: [{date: start, amount: 900000, note: ''}]};
        s.piggies[pig2.id] = pig2;
        const rule = {
            id: C.newId(), title: 'Corridas de app', active: true, strict: true, order: 1, onUpdate: false, stopProcessing: false,
            triggers: [{type: 'descricao_contem', value: 'uber'}],
            actions: [{type: 'definir_categoria', value: cat['Transporte']}, {type: 'definir_orcamento', value: bud['Transporte']}],
        };
        s.rules[rule.id] = rule;
        return s;
    }

    boot();
})();
