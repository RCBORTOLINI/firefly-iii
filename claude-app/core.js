/*
 * core.js — regras de negócio do Vagalume.
 *
 * Vagalume é uma adaptação do Firefly III (https://github.com/firefly-iii/firefly-iii)
 * para rodar como página do Claude, sem servidor próprio.
 * Firefly III: Copyright (c) James Cole <james@firefly-iii.org> e colaboradores.
 * Modificações: Copyright (c) 2026 rcbortolini.
 *
 * Este programa é software livre: você pode redistribuí-lo e/ou modificá-lo
 * sob os termos da GNU Affero General Public License publicada pela
 * Free Software Foundation, na versão 3 da licença ou (a seu critério)
 * qualquer versão posterior.
 *
 * Este programa é distribuído na esperança de que seja útil, mas SEM
 * NENHUMA GARANTIA; sem mesmo a garantia implícita de COMERCIABILIDADE ou
 * ADEQUAÇÃO A UM DETERMINADO FIM. Veja a GNU Affero General Public License
 * para mais detalhes: <https://www.gnu.org/licenses/>.
 *
 * Todos os valores em dinheiro são centavos inteiros (R$ 12,34 = 1234).
 * Todas as datas são strings 'AAAA-MM-DD'.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.FFCore = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---------------------------------------------------------------- dinheiro

    const brl = new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL'});
    const brlCompact = new Intl.NumberFormat('pt-BR', {
        style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1,
    });

    function fmtMoney(cents) {
        const v = Math.round(cents || 0) / 100;
        return brl.format(v === 0 ? 0 : v).replace(/ /g, ' ');
    }

    function fmtMoneyCompact(cents) {
        const v = Math.round(cents || 0) / 100;
        if (Math.abs(v) < 1000) {
            return brl.format(Math.round(v)).replace(/,00$/, '').replace(/ /g, ' ');
        }
        return brlCompact.format(v).replace(/ /g, ' ');
    }

    /** "1.234,56", "1234,5", "1234.56", "R$ 10" → centavos. NaN se inválido. */
    function parseMoney(input) {
        if (typeof input === 'number') {
            return Number.isFinite(input) ? Math.round(input * 100) : NaN;
        }
        let s = String(input == null ? '' : input).replace(/R\$|\s/g, '');
        if (!s) {
            return NaN;
        }
        let neg = false;
        if (s[0] === '-') {
            neg = true;
            s = s.slice(1);
        }
        if (s.includes(',')) {
            s = s.replace(/\./g, '').replace(',', '.');
        } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
            s = s.replace(/\./g, '');
        }
        if (!/^\d+(\.\d*)?$/.test(s)) {
            return NaN;
        }
        const [i, f = ''] = s.split('.');
        let cents = parseInt(i, 10) * 100 + parseInt((f + '00').slice(0, 2), 10);
        if (f.length > 2 && +f[2] >= 5) {
            cents += 1;
        }
        return neg ? -cents : cents;
    }

    /** Centavos → texto para campo de formulário ("1234,56"). */
    function moneyToInput(cents) {
        if (cents == null || Number.isNaN(cents)) {
            return '';
        }
        return (cents / 100).toFixed(2).replace('.', ',');
    }

    // ------------------------------------------------------------------- datas

    const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto',
        'setembro', 'outubro', 'novembro', 'dezembro'];
    const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira',
        'sexta-feira', 'sábado'];

    const pad = (n) => String(n).padStart(2, '0');

    function isISODate(s) {
        if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
            return false;
        }
        const [y, m, d] = s.split('-').map(Number);
        return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
    }

    function parseISO(s) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d));
    }

    function toISO(d) {
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }

    /** Data local de hoje (não UTC). */
    function todayISO(now) {
        const d = now || new Date();
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function daysInMonth(y, m) {
        return new Date(Date.UTC(y, m, 0)).getUTCDate();
    }

    function addDays(s, n) {
        const d = parseISO(s);
        d.setUTCDate(d.getUTCDate() + n);
        return toISO(d);
    }

    /** Soma meses mantendo o dia `anchorDay` (ou o dia de `s`), limitado ao fim do mês. */
    function addMonths(s, n, anchorDay) {
        const [y, m, d] = s.split('-').map(Number);
        const t = y * 12 + (m - 1) + n;
        const ny = Math.floor(t / 12);
        const nm = (t % 12 + 12) % 12 + 1;
        const day = Math.min(anchorDay || d, daysInMonth(ny, nm));
        return ny + '-' + pad(nm) + '-' + pad(day);
    }

    function diffDays(a, b) {
        return Math.round((parseISO(b) - parseISO(a)) / 86400000);
    }

    const monthKey = (s) => s.slice(0, 7);
    const monthStart = (mk) => mk + '-01';

    function monthEnd(mk) {
        const [y, m] = mk.split('-').map(Number);
        return mk + '-' + pad(daysInMonth(y, m));
    }

    function shiftMonth(mk, n) {
        return addMonths(mk + '-01', n).slice(0, 7);
    }

    function fmtDate(s, style) {
        if (!isISODate(s)) {
            return '';
        }
        const [y, m, d] = s.split('-').map(Number);
        switch (style) {
            case 'curta':
                return d + ' ' + MESES_CURTOS[m - 1];
            case 'longa':
                return d + ' de ' + MESES[m - 1] + ' de ' + y;
            case 'dia':
                return DIAS_SEMANA[parseISO(s).getUTCDay()] + ', ' + d + ' de ' + MESES[m - 1];
            default:
                return pad(d) + '/' + pad(m) + '/' + y;
        }
    }

    function fmtMonth(mk, style) {
        const [y, m] = mk.split('-').map(Number);
        if (style === 'curta') {
            return MESES_CURTOS[m - 1];
        }
        return MESES[m - 1] + ' de ' + y;
    }

    // ------------------------------------------------------------------ contas

    /** Tipos de conta. `grupo` segue os tipos do Firefly III (ativo, despesa, receita, passivo). */
    const ACCOUNT_KINDS = {
        corrente: {grupo: 'ativo', label: 'Conta corrente'},
        poupanca: {grupo: 'ativo', label: 'Poupança'},
        dinheiro: {grupo: 'ativo', label: 'Dinheiro'},
        investimento: {grupo: 'ativo', label: 'Investimento'},
        cartao: {grupo: 'ativo', label: 'Cartão de crédito'},
        emprestimo: {grupo: 'passivo', label: 'Empréstimo'},
        divida: {grupo: 'passivo', label: 'Dívida'},
        financiamento: {grupo: 'passivo', label: 'Financiamento'},
        despesa: {grupo: 'despesa', label: 'Conta de despesa'},
        receita: {grupo: 'receita', label: 'Conta de receita'},
    };

    const groupOf = (acc) => (acc && ACCOUNT_KINDS[acc.kind] ? ACCOUNT_KINDS[acc.kind].grupo : null);
    const isOwnGroup = (g) => g === 'ativo' || g === 'passivo';
    const isOwn = (acc) => isOwnGroup(groupOf(acc));
    /** Contas em que o saldo representa algo devido (mostrado como "devendo"). */
    const isDebtLike = (acc) => !!acc && (groupOf(acc) === 'passivo' || acc.kind === 'cartao');

    const TX_TYPES = {
        retirada: {label: 'Despesa', plural: 'Despesas'},
        deposito: {label: 'Receita', plural: 'Receitas'},
        transferencia: {label: 'Transferência', plural: 'Transferências'},
    };

    /** O tipo do lançamento vem dos tipos das contas, como no Firefly III. */
    function inferType(src, dst) {
        const s = groupOf(src);
        const d = groupOf(dst);
        if (isOwnGroup(s) && d === 'despesa') {
            return 'retirada';
        }
        if (s === 'receita' && isOwnGroup(d)) {
            return 'deposito';
        }
        if (isOwnGroup(s) && isOwnGroup(d)) {
            return 'transferencia';
        }
        return null;
    }

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function emptyState() {
        return {
            accounts: {}, categories: {}, budgets: {}, bills: {}, recurrences: {},
            piggies: {}, rules: {}, settings: {}, tx: {},
        };
    }

    const lc = (s) => String(s == null ? '' : s).toLocaleLowerCase('pt-BR').trim();

    function findAccountByName(state, name, grupo) {
        const n = lc(name);
        return Object.values(state.accounts).find((a) => lc(a.name) === n && (!grupo || groupOf(a) === grupo)) || null;
    }

    /** Saldos de todas as contas até `upTo` (inclusive). Sem `upTo`, saldo atual de tudo. */
    function computeBalances(state, upTo) {
        const b = {};
        for (const a of Object.values(state.accounts)) {
            const counts = !upTo || !a.openingDate || a.openingDate <= upTo;
            b[a.id] = counts ? (a.openingBalance || 0) : 0;
        }
        for (const t of Object.values(state.tx)) {
            if (upTo && t.date > upTo) {
                continue;
            }
            if (t.source in b) {
                b[t.source] -= t.amount;
            }
            if (t.dest in b) {
                b[t.dest] += t.amount;
            }
        }
        return b;
    }

    function netWorth(state, upTo, balances) {
        const b = balances || computeBalances(state, upTo);
        let total = 0;
        for (const a of Object.values(state.accounts)) {
            if (isOwn(a) && a.includeNetWorth !== false) {
                total += b[a.id] || 0;
            }
        }
        return total;
    }

    /** Saldo diário somado das contas `accIds` entre `from` e `to`. */
    function dailyBalance(state, accIds, from, to) {
        const ids = new Set(accIds);
        const before = computeBalances(state, addDays(from, -1));
        let run = 0;
        for (const id of ids) {
            run += before[id] || 0;
        }
        const delta = {};
        const bump = (d, v) => {
            delta[d] = (delta[d] || 0) + v;
        };
        for (const a of Object.values(state.accounts)) {
            if (ids.has(a.id) && a.openingDate && a.openingDate >= from && a.openingDate <= to) {
                bump(a.openingDate, a.openingBalance || 0);
            }
        }
        for (const t of Object.values(state.tx)) {
            if (t.date < from || t.date > to) {
                continue;
            }
            if (ids.has(t.source)) {
                bump(t.date, -t.amount);
            }
            if (ids.has(t.dest)) {
                bump(t.date, t.amount);
            }
        }
        const out = [];
        for (let d = from; d <= to; d = addDays(d, 1)) {
            run += delta[d] || 0;
            out.push({date: d, value: run});
        }
        return out;
    }

    // ------------------------------------------------------------- lançamentos

    function txSort(a, b) {
        if (a.date !== b.date) {
            return a.date < b.date ? 1 : -1;
        }
        return (b.createdAt || '').localeCompare(a.createdAt || '');
    }

    function txInRange(state, from, to, filter) {
        const out = [];
        for (const t of Object.values(state.tx)) {
            if ((!from || t.date >= from) && (!to || t.date <= to) && (!filter || filter(t))) {
                out.push(t);
            }
        }
        return out.sort(txSort);
    }

    function cleanTags(tags) {
        const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
        const seen = new Set();
        const out = [];
        for (const raw of list) {
            const t = String(raw).trim();
            if (t && !seen.has(lc(t))) {
                seen.add(lc(t));
                out.push(t);
            }
        }
        return out;
    }

    /** Deixa o lançamento consistente: tipo vindo das contas, orçamento só em despesa etc. */
    function normalizeTx(state, t) {
        const n = Object.assign({}, t);
        n.type = inferType(state.accounts[n.source], state.accounts[n.dest]) || n.type;
        n.tags = cleanTags(n.tags);
        n.description = String(n.description || '').trim();
        n.notes = String(n.notes || '').trim();
        if (n.type !== 'retirada') {
            n.budgetId = null;
            n.billId = null;
        }
        for (const k of ['categoryId', 'budgetId', 'billId', 'recurrenceId']) {
            if (!n[k]) {
                n[k] = null;
            }
        }
        if (n.categoryId && !state.categories[n.categoryId]) {
            n.categoryId = null;
        }
        if (n.budgetId && !state.budgets[n.budgetId]) {
            n.budgetId = null;
        }
        if (n.billId && !state.bills[n.billId]) {
            n.billId = null;
        }
        return n;
    }

    /** Mensagem de erro em português, ou null se o lançamento é válido. */
    function validateTx(state, t) {
        if (!t.description) {
            return 'Informe uma descrição.';
        }
        if (!Number.isInteger(t.amount) || t.amount <= 0) {
            return 'Informe um valor maior que zero.';
        }
        if (!isISODate(t.date)) {
            return 'Informe uma data válida.';
        }
        const s = state.accounts[t.source];
        const d = state.accounts[t.dest];
        if (!s || !d) {
            return 'Escolha as contas de origem e de destino.';
        }
        if (s.id === d.id) {
            return 'A conta de origem e a de destino precisam ser diferentes.';
        }
        if (!inferType(s, d)) {
            return 'Essa combinação de contas não forma uma despesa, receita ou transferência.';
        }
        return null;
    }

    // -------------------------------------------------------------- relatórios

    function summarize(state, from, to) {
        const r = {
            income: 0, expense: 0, transfers: 0, count: 0,
            byCategory: {}, byCategoryIncome: {}, byBudget: {}, byExpenseAccount: {}, byRevenueAccount: {}, byTag: {},
        };
        const add = (map, k, v) => {
            map[k || ''] = (map[k || ''] || 0) + v;
        };
        for (const t of Object.values(state.tx)) {
            if (t.date < from || t.date > to) {
                continue;
            }
            r.count++;
            if (t.type === 'retirada') {
                r.expense += t.amount;
                add(r.byCategory, t.categoryId, t.amount);
                add(r.byBudget, t.budgetId, t.amount);
                add(r.byExpenseAccount, t.dest, t.amount);
                for (const tag of t.tags || []) {
                    add(r.byTag, tag, t.amount);
                }
            } else if (t.type === 'deposito') {
                r.income += t.amount;
                add(r.byCategoryIncome, t.categoryId, t.amount);
                add(r.byRevenueAccount, t.source, t.amount);
            } else {
                r.transfers += t.amount;
            }
        }
        r.net = r.income - r.expense;
        return r;
    }

    function monthlySeries(state, endMk, n) {
        const out = [];
        for (let i = n - 1; i >= 0; i--) {
            const mk = shiftMonth(endMk, -i);
            const s = summarize(state, monthStart(mk), monthEnd(mk));
            out.push({month: mk, income: s.income, expense: s.expense, net: s.net, netWorth: netWorth(state, monthEnd(mk))});
        }
        return out;
    }

    /** Ordena um mapa {id: valor} e junta o que passar de `max` itens em "Outros". */
    function topEntries(map, max) {
        const list = Object.entries(map).map(([id, v]) => ({id, value: v})).filter((e) => e.value !== 0);
        list.sort((a, b) => b.value - a.value);
        if (max && list.length > max) {
            const rest = list.splice(max - 1);
            list.push({id: '__outros', value: rest.reduce((s, e) => s + e.value, 0), count: rest.length});
        }
        return list;
    }

    // -------------------------------------------------------------- orçamentos

    function budgetLimit(budget, mk) {
        if (budget.limits && budget.limits[mk] != null) {
            return budget.limits[mk];
        }
        return budget.defaultAmount != null ? budget.defaultAmount : null;
    }

    function budgetSpent(state, budgetId, mk) {
        const from = monthStart(mk);
        const to = monthEnd(mk);
        let s = 0;
        for (const t of Object.values(state.tx)) {
            if (t.budgetId === budgetId && t.type === 'retirada' && t.date >= from && t.date <= to) {
                s += t.amount;
            }
        }
        return s;
    }

    function budgetOverview(state, mk, today) {
        const list = Object.values(state.budgets)
            .filter((b) => b.active !== false)
            .sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'pt-BR'));
        const isCurrent = today && monthKey(today) === mk;
        const daysLeft = isCurrent ? diffDays(today, monthEnd(mk)) + 1 : 0;
        return list.map((b) => {
            const limit = budgetLimit(b, mk);
            const spent = budgetSpent(state, b.id, mk);
            const left = limit == null ? null : limit - spent;
            return {
                budget: b, limit, spent, left,
                pct: limit ? spent / limit : null,
                perDay: isCurrent && left != null && left > 0 ? Math.floor(left / daysLeft) : null,
            };
        });
    }

    // ------------------------------------------------- contas recorrentes (bills)

    const BILL_FREQ = {
        semanal: {label: 'Semanal', days: 7},
        mensal: {label: 'Mensal', months: 1},
        trimestral: {label: 'Trimestral', months: 3},
        semestral: {label: 'Semestral', months: 6},
        anual: {label: 'Anual', months: 12},
    };

    function stepDate(base, freq, k) {
        if (freq.days) {
            return addDays(base, freq.days * k);
        }
        return addMonths(base, freq.months * k, +base.slice(8, 10));
    }

    function billDates(bill, from, to) {
        const freq = BILL_FREQ[bill.repeatFreq] || BILL_FREQ.mensal;
        const step = (bill.skip || 0) + 1;
        const out = [];
        let k = 0;
        // Pula direto para perto de `from` em frequências mensais, para não iterar anos à toa.
        if (freq.months && bill.date < from) {
            const months = (+from.slice(0, 4) - +bill.date.slice(0, 4)) * 12 + (+from.slice(5, 7) - +bill.date.slice(5, 7));
            k = Math.max(0, Math.floor(months / (freq.months * step)) - 1);
        }
        for (let guard = 0; guard < 2000; guard++, k++) {
            const d = stepDate(bill.date, freq, k * step);
            if (d > to || (bill.endDate && d > bill.endDate)) {
                break;
            }
            if (d >= from) {
                out.push(d);
            }
        }
        return out;
    }

    function billAverage(bill) {
        return Math.round(((bill.amountMin || 0) + (bill.amountMax || 0)) / 2);
    }

    /** Situação da conta recorrente no mês: vencimentos, lançamentos vinculados e status. */
    function billMonthStatus(state, bill, mk, today) {
        const from = monthStart(mk);
        const to = monthEnd(mk);
        const dates = billDates(bill, from, to);
        const paid = txInRange(state, from, to, (t) => t.billId === bill.id).reverse();
        const paidAmount = paid.reduce((s, t) => s + t.amount, 0);
        let status = 'sem_vencimento';
        if (dates.length) {
            if (paid.length >= dates.length) {
                status = 'paga';
            } else if (today && dates[paid.length] < today) {
                status = 'atrasada';
            } else {
                status = 'pendente';
            }
        } else if (paid.length) {
            status = 'paga';
        }
        const missing = Math.max(0, dates.length - paid.length);
        return {
            bill, dates, paid, paidAmount, status,
            nextDate: dates[paid.length] || null,
            remaining: missing * billAverage(bill),
        };
    }

    function nextBillDate(bill, fromDate) {
        const d = billDates(bill, fromDate, addDays(fromDate, 800));
        return d[0] || null;
    }

    // -------------------------------------------------------------- recorrências

    const REC_FREQ = {
        diaria: {label: 'Diária', days: 1},
        semanal: {label: 'Semanal', days: 7},
        mensal: {label: 'Mensal', months: 1},
        anual: {label: 'Anual', months: 12},
    };

    function recurrenceDates(rec, from, to) {
        const freq = REC_FREQ[rec.repeatFreq] || REC_FREQ.mensal;
        const step = (rec.skip || 0) + 1;
        const out = [];
        for (let k = 0; k < 5000; k++) {
            if (rec.repetitions && k >= rec.repetitions) {
                break;
            }
            const d = stepDate(rec.firstDate, freq, k * step);
            if (d > to || (rec.endDate && d > rec.endDate)) {
                break;
            }
            if (d >= from) {
                out.push(d);
            }
        }
        return out;
    }

    /** Datas ainda não criadas de cada recorrência ativa, até hoje. */
    function dueRecurrences(state, today) {
        const out = [];
        for (const rec of Object.values(state.recurrences)) {
            if (rec.active === false || !isISODate(rec.firstDate)) {
                continue;
            }
            const from = rec.lastCreated ? addDays(rec.lastCreated, 1) : rec.firstDate;
            if (from > today) {
                continue;
            }
            const dates = recurrenceDates(rec, from, today);
            if (dates.length) {
                out.push({rec, dates});
            }
        }
        return out;
    }

    function recurrenceTx(rec, date) {
        return {
            id: newId(), date,
            type: rec.type,
            description: rec.description || rec.title,
            amount: rec.amount,
            source: rec.source, dest: rec.dest,
            categoryId: rec.categoryId || null,
            budgetId: rec.budgetId || null,
            billId: rec.billId || null,
            tags: (rec.tags || []).slice(),
            notes: rec.notes || '',
            recurrenceId: rec.id,
            createdAt: new Date().toISOString(),
        };
    }

    // ------------------------------------------------------------------- regras

    const num = (v) => Number(v);

    /** Gatilhos (condições). `input` diz que tipo de valor a condição usa. */
    const RULE_TRIGGERS = {
        descricao_contem: {label: 'Descrição contém', input: 'texto', test: (t, v) => lc(t.description).includes(lc(v))},
        descricao_comeca: {label: 'Descrição começa com', input: 'texto', test: (t, v) => lc(t.description).startsWith(lc(v))},
        descricao_termina: {label: 'Descrição termina com', input: 'texto', test: (t, v) => lc(t.description).endsWith(lc(v))},
        descricao_igual: {label: 'Descrição é', input: 'texto', test: (t, v) => lc(t.description) === lc(v)},
        valor_maior: {label: 'Valor maior que', input: 'valor', test: (t, v) => t.amount > num(v)},
        valor_menor: {label: 'Valor menor que', input: 'valor', test: (t, v) => t.amount < num(v)},
        valor_igual: {label: 'Valor é', input: 'valor', test: (t, v) => t.amount === num(v)},
        origem_e: {label: 'Conta de origem é', input: 'texto', test: (t, v, c) => lc(c.accName(t.source)) === lc(v)},
        origem_contem: {label: 'Conta de origem contém', input: 'texto', test: (t, v, c) => lc(c.accName(t.source)).includes(lc(v))},
        destino_e: {label: 'Conta de destino é', input: 'texto', test: (t, v, c) => lc(c.accName(t.dest)) === lc(v)},
        destino_contem: {label: 'Conta de destino contém', input: 'texto', test: (t, v, c) => lc(c.accName(t.dest)).includes(lc(v))},
        tipo_e: {label: 'Tipo é', input: 'tipo', test: (t, v) => t.type === v},
        categoria_e: {label: 'Categoria é', input: 'categoria', test: (t, v) => t.categoryId === v},
        sem_categoria: {label: 'Não tem categoria', input: null, test: (t) => !t.categoryId},
        orcamento_e: {label: 'Orçamento é', input: 'orcamento', test: (t, v) => t.budgetId === v},
        sem_orcamento: {label: 'Não tem orçamento', input: null, test: (t) => !t.budgetId},
        tem_tag: {label: 'Tem a tag', input: 'texto', test: (t, v) => (t.tags || []).some((x) => lc(x) === lc(v))},
        notas_contem: {label: 'Notas contêm', input: 'texto', test: (t, v) => lc(t.notes).includes(lc(v))},
    };

    const RULE_ACTIONS = {
        definir_categoria: {label: 'Definir categoria', input: 'categoria', apply: (t, v) => {
            t.categoryId = v || null;
        }},
        remover_categoria: {label: 'Remover categoria', input: null, apply: (t) => {
            t.categoryId = null;
        }},
        definir_orcamento: {label: 'Definir orçamento', input: 'orcamento', apply: (t, v) => {
            if (t.type === 'retirada') {
                t.budgetId = v || null;
            }
        }},
        remover_orcamento: {label: 'Remover orçamento', input: null, apply: (t) => {
            t.budgetId = null;
        }},
        vincular_conta_recorrente: {label: 'Vincular à conta recorrente', input: 'conta_recorrente', apply: (t, v) => {
            if (t.type === 'retirada') {
                t.billId = v || null;
            }
        }},
        adicionar_tag: {label: 'Adicionar tag', input: 'texto', apply: (t, v) => {
            t.tags = cleanTags((t.tags || []).concat([v]));
        }},
        remover_tag: {label: 'Remover tag', input: 'texto', apply: (t, v) => {
            t.tags = (t.tags || []).filter((x) => lc(x) !== lc(v));
        }},
        remover_tags: {label: 'Remover todas as tags', input: null, apply: (t) => {
            t.tags = [];
        }},
        definir_descricao: {label: 'Definir descrição', input: 'texto', apply: (t, v) => {
            t.description = String(v || '');
        }},
        acrescentar_descricao: {label: 'Acrescentar ao fim da descrição', input: 'texto', apply: (t, v) => {
            t.description = t.description + String(v || '');
        }},
        prefixar_descricao: {label: 'Acrescentar ao início da descrição', input: 'texto', apply: (t, v) => {
            t.description = String(v || '') + t.description;
        }},
        definir_notas: {label: 'Definir notas', input: 'texto', apply: (t, v) => {
            t.notes = String(v || '');
        }},
        definir_destino: {label: 'Definir conta de destino (despesa)', input: 'texto', apply: (t, v, c) => {
            if (t.type === 'retirada' && String(v || '').trim()) {
                t.dest = c.ensureAccount(v, 'despesa');
            }
        }},
        definir_origem: {label: 'Definir conta de origem (receita)', input: 'texto', apply: (t, v, c) => {
            if (t.type === 'deposito' && String(v || '').trim()) {
                t.source = c.ensureAccount(v, 'receita');
            }
        }},
    };

    function sortedRules(state) {
        return Object.values(state.rules).sort((a, b) => (a.order || 0) - (b.order || 0) || (a.title || '').localeCompare(b.title || '', 'pt-BR'));
    }

    function ruleMatches(rule, t, ctx) {
        const trig = (rule.triggers || []).filter((x) => RULE_TRIGGERS[x.type]);
        if (!trig.length) {
            return false;
        }
        const res = trig.map((x) => !!RULE_TRIGGERS[x.type].test(t, x.value, ctx));
        return rule.strict === false ? res.some(Boolean) : res.every(Boolean);
    }

    /**
     * Aplica as regras ativas, em ordem, a uma cópia do lançamento.
     * `event` é 'criar' ou 'editar'; regras sem `onUpdate` só rodam ao criar.
     * Com `only`, roda apenas a regra indicada (usado em "aplicar aos existentes").
     */
    function applyRules(state, tx, ctx, opts) {
        const o = opts || {};
        const t = Object.assign({}, tx, {tags: (tx.tags || []).slice()});
        const applied = [];
        const rules = o.only ? [o.only] : sortedRules(state);
        for (const rule of rules) {
            if (!o.only && (rule.active === false || (o.event === 'editar' && !rule.onUpdate))) {
                continue;
            }
            if (!ruleMatches(rule, t, ctx)) {
                continue;
            }
            for (const a of rule.actions || []) {
                if (RULE_ACTIONS[a.type]) {
                    RULE_ACTIONS[a.type].apply(t, a.value, ctx);
                }
            }
            applied.push(rule.id);
            if (rule.stopProcessing) {
                break;
            }
        }
        return {tx: t, applied};
    }

    // ---------------------------------------------------------------- cofrinhos

    function piggyInfo(p, today) {
        const saved = (p.events || []).reduce((s, e) => s + e.amount, 0);
        const target = p.target || 0;
        const left = Math.max(0, target - saved);
        let perMonth = null;
        if (p.targetDate && left > 0 && today && p.targetDate >= today) {
            const months = Math.max(1,
                (+p.targetDate.slice(0, 4) - +today.slice(0, 4)) * 12 + (+p.targetDate.slice(5, 7) - +today.slice(5, 7)));
            perMonth = Math.ceil(left / months);
        }
        return {saved, target, left, pct: target ? Math.min(1, saved / target) : 0, perMonth};
    }

    /** Quanto já está reservado em cofrinhos, por conta. */
    function piggySavedByAccount(state) {
        const out = {};
        for (const p of Object.values(state.piggies)) {
            out[p.accountId] = (out[p.accountId] || 0) + piggyInfo(p).saved;
        }
        return out;
    }

    // ------------------------------------------------------------------- backup

    const ENTITY_KEYS = ['accounts', 'categories', 'budgets', 'bills', 'recurrences', 'piggies', 'rules'];

    function exportData(state) {
        const data = {settings: state.settings || {}, transactions: Object.values(state.tx).sort(txSort).reverse()};
        for (const k of ENTITY_KEYS) {
            data[k] = Object.values(state[k]);
        }
        return {
            app: 'Vagalume', format: 1, exportedAt: new Date().toISOString(),
            note: 'Backup do Vagalume, adaptação do Firefly III (AGPL-3.0).',
            data,
        };
    }

    /** Lê um backup exportado. Lança Error com mensagem em português se for inválido. */
    function importData(json) {
        const obj = typeof json === 'string' ? JSON.parse(json) : json;
        if (!obj || obj.app !== 'Vagalume' || !obj.data) {
            throw new Error('Esse arquivo não é um backup do Vagalume.');
        }
        if (obj.format !== 1) {
            throw new Error('Versão de backup não suportada.');
        }
        const state = emptyState();
        for (const k of ENTITY_KEYS) {
            for (const item of obj.data[k] || []) {
                if (item && item.id) {
                    state[k][item.id] = item;
                }
            }
        }
        state.settings = obj.data.settings || {};
        for (const t of obj.data.transactions || []) {
            if (t && t.id && isISODate(t.date) && Number.isInteger(t.amount)) {
                state.tx[t.id] = t;
            }
        }
        return state;
    }

    return {
        fmtMoney, fmtMoneyCompact, parseMoney, moneyToInput,
        MESES, MESES_CURTOS, DIAS_SEMANA, isISODate, todayISO, addDays, addMonths, diffDays,
        monthKey, monthStart, monthEnd, shiftMonth, fmtDate, fmtMonth, daysInMonth,
        ACCOUNT_KINDS, groupOf, isOwn, isDebtLike, TX_TYPES, inferType, newId, emptyState,
        findAccountByName, computeBalances, netWorth, dailyBalance,
        txSort, txInRange, cleanTags, normalizeTx, validateTx,
        summarize, monthlySeries, topEntries,
        budgetLimit, budgetSpent, budgetOverview,
        BILL_FREQ, billDates, billAverage, billMonthStatus, nextBillDate,
        REC_FREQ, recurrenceDates, dueRecurrences, recurrenceTx,
        RULE_TRIGGERS, RULE_ACTIONS, sortedRules, ruleMatches, applyRules,
        piggyInfo, piggySavedByAccount,
        exportData, importData,
    };
});
