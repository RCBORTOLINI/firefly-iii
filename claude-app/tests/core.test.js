// Testes das regras de negócio do Vagalume. Rode com: node --test claude-app/tests/core.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

function fixture() {
    const s = C.emptyState();
    const acc = (id, name, kind, extra) => {
        s.accounts[id] = Object.assign({id, name, kind}, extra || {});
    };
    acc('cc', 'Conta corrente', 'corrente', {openingBalance: 100000, openingDate: '2026-01-01'});
    acc('poup', 'Poupança', 'poupanca', {openingBalance: 50000, openingDate: '2026-01-01'});
    acc('cartao', 'Cartão', 'cartao', {openingBalance: 0});
    acc('emp', 'Empréstimo', 'emprestimo', {openingBalance: -300000, openingDate: '2026-01-01'});
    acc('merc', 'Mercado', 'despesa');
    acc('sal', 'Empresa', 'receita');
    s.categories.ali = {id: 'ali', name: 'Alimentação'};
    s.budgets.b1 = {id: 'b1', name: 'Mercado', defaultAmount: 80000, limits: {'2026-02': 50000}};
    const tx = (id, date, source, dest, amount, extra) => {
        s.tx[id] = C.normalizeTx(s, Object.assign({id, date, source, dest, amount, description: id}, extra || {}));
    };
    tx('t1', '2026-01-05', 'sal', 'cc', 500000);
    tx('t2', '2026-01-10', 'cc', 'merc', 30000, {categoryId: 'ali', budgetId: 'b1'});
    tx('t3', '2026-01-15', 'cc', 'poup', 100000);
    tx('t4', '2026-02-02', 'cartao', 'merc', 12345, {budgetId: 'b1'});
    tx('t5', '2026-02-03', 'cc', 'emp', 50000);
    return s;
}

test('dinheiro: leitura e formatação em reais', () => {
    assert.equal(C.parseMoney('1.234,56'), 123456);
    assert.equal(C.parseMoney('R$ 10'), 1000);
    assert.equal(C.parseMoney('10,5'), 1050);
    assert.equal(C.parseMoney('1234.56'), 123456);
    assert.equal(C.parseMoney('1.000'), 100000);
    assert.equal(C.parseMoney('1,005'), 101);
    assert.equal(C.parseMoney('-2,00'), -200);
    assert.ok(Number.isNaN(C.parseMoney('abc')));
    assert.ok(Number.isNaN(C.parseMoney('')));
    assert.equal(C.fmtMoney(123456), 'R$ 1.234,56');
    assert.equal(C.fmtMoney(-500), '-R$ 5,00');
    assert.equal(C.moneyToInput(123456), '1234,56');
});

test('datas: meses com fim de mês e formatos', () => {
    assert.equal(C.addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(C.addMonths('2026-01-31', 2, 31), '2026-03-31');
    assert.equal(C.addMonths('2026-01-15', -1), '2025-12-15');
    assert.equal(C.shiftMonth('2026-01', -1), '2025-12');
    assert.equal(C.monthEnd('2028-02'), '2028-02-29');
    assert.equal(C.fmtDate('2026-10-23'), '23/10/2026');
    assert.equal(C.fmtDate('2026-10-23', 'dia'), 'sexta-feira, 23 de outubro');
    assert.equal(C.fmtMonth('2026-10'), 'outubro de 2026');
    assert.ok(!C.isISODate('2026-02-30'));
});

test('tipo do lançamento vem das contas', () => {
    const s = fixture();
    assert.equal(s.tx.t1.type, 'deposito');
    assert.equal(s.tx.t2.type, 'retirada');
    assert.equal(s.tx.t3.type, 'transferencia');
    assert.equal(s.tx.t5.type, 'transferencia');
    assert.equal(C.inferType(s.accounts.merc, s.accounts.cc), null);
});

test('normalização tira orçamento de quem não é despesa', () => {
    const s = fixture();
    const t = C.normalizeTx(s, {id: 'x', date: '2026-01-01', source: 'sal', dest: 'cc', amount: 1, budgetId: 'b1', tags: 'a, b ,A'});
    assert.equal(t.budgetId, null);
    assert.deepEqual(t.tags, ['a', 'b']);
});

test('validação em português', () => {
    const s = fixture();
    const base = {description: 'x', amount: 100, date: '2026-01-01', source: 'cc', dest: 'merc'};
    assert.equal(C.validateTx(s, base), null);
    assert.match(C.validateTx(s, Object.assign({}, base, {amount: 0})), /valor/);
    assert.match(C.validateTx(s, Object.assign({}, base, {dest: 'cc'})), /diferentes/);
    assert.match(C.validateTx(s, Object.assign({}, base, {source: 'merc', dest: 'sal'})), /combinação/);
});

test('saldos em partidas dobradas e patrimônio', () => {
    const s = fixture();
    const b = C.computeBalances(s);
    assert.equal(b.cc, 100000 + 500000 - 30000 - 100000 - 50000);
    assert.equal(b.poup, 150000);
    assert.equal(b.cartao, -12345);
    assert.equal(b.emp, -250000);
    assert.equal(b.merc, 42345);
    assert.equal(C.netWorth(s), b.cc + b.poup + b.cartao + b.emp);
    const jan = C.computeBalances(s, '2026-01-31');
    assert.equal(jan.cc, 470000);
    const serie = C.dailyBalance(s, ['cc'], '2026-01-01', '2026-01-31');
    assert.equal(serie.length, 31);
    assert.equal(serie[0].value, 100000);
    assert.equal(serie[30].value, 470000);
});

test('resumo mensal e série', () => {
    const s = fixture();
    const r = C.summarize(s, '2026-01-01', '2026-01-31');
    assert.equal(r.income, 500000);
    assert.equal(r.expense, 30000);
    assert.equal(r.transfers, 100000);
    assert.equal(r.byCategory.ali, 30000);
    const serie = C.monthlySeries(s, '2026-02', 2);
    assert.deepEqual(serie.map((m) => m.month), ['2026-01', '2026-02']);
    assert.equal(serie[1].expense, 12345);
    const top = C.topEntries({a: 5, b: 4, c: 3, d: 2}, 3);
    assert.deepEqual(top.map((e) => e.id), ['a', 'b', '__outros']);
    assert.equal(top[2].value, 5);
});

test('orçamento: limite do mês, padrão e por dia', () => {
    const s = fixture();
    assert.equal(C.budgetLimit(s.budgets.b1, '2026-01'), 80000);
    assert.equal(C.budgetLimit(s.budgets.b1, '2026-02'), 50000);
    const [o] = C.budgetOverview(s, '2026-02', '2026-02-19');
    assert.equal(o.spent, 12345);
    assert.equal(o.left, 50000 - 12345);
    assert.equal(o.perDay, Math.floor((50000 - 12345) / 10));
});

test('contas recorrentes: vencimentos e situação', () => {
    const s = fixture();
    const bill = {id: 'luz', name: 'Luz', amountMin: 10000, amountMax: 20000, date: '2025-11-30', repeatFreq: 'mensal', skip: 0};
    s.bills.luz = bill;
    assert.deepEqual(C.billDates(bill, '2026-02-01', '2026-02-28'), ['2026-02-28']);
    assert.deepEqual(C.billDates(bill, '2026-03-01', '2026-03-31'), ['2026-03-30']);
    const tri = Object.assign({}, bill, {repeatFreq: 'trimestral', date: '2026-01-10'});
    assert.deepEqual(C.billDates(tri, '2026-01-01', '2026-12-31'), ['2026-01-10', '2026-04-10', '2026-07-10', '2026-10-10']);
    const bimestral = Object.assign({}, bill, {date: '2026-01-10', skip: 1});
    assert.deepEqual(C.billDates(bimestral, '2026-01-01', '2026-06-30'), ['2026-01-10', '2026-03-10', '2026-05-10']);
    let st = C.billMonthStatus(s, bill, '2026-02', '2026-03-05');
    assert.equal(st.status, 'atrasada');
    assert.equal(st.remaining, 15000);
    s.tx.p = C.normalizeTx(s, {id: 'p', date: '2026-02-27', source: 'cc', dest: 'merc', amount: 15500, description: 'Luz', billId: 'luz'});
    st = C.billMonthStatus(s, bill, '2026-02', '2026-03-05');
    assert.equal(st.status, 'paga');
    assert.equal(C.nextBillDate(bill, '2026-03-01'), '2026-03-30');
});

test('recorrências: datas devidas e lançamento gerado', () => {
    const s = fixture();
    s.recurrences.r1 = {
        id: 'r1', title: 'Aluguel', type: 'retirada', amount: 150000, source: 'cc', dest: 'merc',
        firstDate: '2026-01-31', repeatFreq: 'mensal', skip: 0, active: true,
    };
    let due = C.dueRecurrences(s, '2026-03-30');
    assert.deepEqual(due[0].dates, ['2026-01-31', '2026-02-28']);
    s.recurrences.r1.lastCreated = '2026-02-28';
    due = C.dueRecurrences(s, '2026-03-31');
    assert.deepEqual(due[0].dates, ['2026-03-31']);
    s.recurrences.r1.repetitions = 2;
    assert.equal(C.dueRecurrences(s, '2026-05-01').length, 0);
    const t = C.recurrenceTx(s.recurrences.r1, '2026-03-31');
    assert.equal(t.recurrenceId, 'r1');
    assert.equal(t.description, 'Aluguel');
});

test('regras: condições, ações e parar processamento', () => {
    const s = fixture();
    const created = [];
    const ctx = {
        accName: (id) => (s.accounts[id] ? s.accounts[id].name : ''),
        ensureAccount: (name, kind) => {
            created.push([name, kind]);
            return 'novo';
        },
    };
    s.rules.r1 = {
        id: 'r1', title: 'Uber', order: 1, active: true, strict: true,
        triggers: [{type: 'descricao_contem', value: 'uber'}, {type: 'valor_menor', value: 10000}],
        actions: [{type: 'definir_categoria', value: 'ali'}, {type: 'adicionar_tag', value: 'transporte'}, {type: 'definir_destino', value: 'Uber'}],
        stopProcessing: true,
    };
    s.rules.r2 = {
        id: 'r2', title: 'Tudo', order: 2, active: true,
        triggers: [{type: 'tipo_e', value: 'retirada'}],
        actions: [{type: 'adicionar_tag', value: 'outra'}],
    };
    const tx = {id: 'n', type: 'retirada', description: 'PAG*UBER TRIP', amount: 2350, source: 'cc', dest: 'merc', tags: []};
    let r = C.applyRules(s, tx, ctx, {event: 'criar'});
    assert.deepEqual(r.applied, ['r1']);
    assert.equal(r.tx.categoryId, 'ali');
    assert.deepEqual(r.tx.tags, ['transporte']);
    assert.equal(r.tx.dest, 'novo');
    assert.deepEqual(created, [['Uber', 'despesa']]);
    assert.deepEqual(tx.tags, [], 'não altera o original');
    r = C.applyRules(s, Object.assign({}, tx, {amount: 20000}), ctx, {event: 'criar'});
    assert.deepEqual(r.applied, ['r2']);
    r = C.applyRules(s, tx, ctx, {event: 'editar'});
    assert.deepEqual(r.applied, []);
    s.rules.r1.strict = false;
    assert.ok(C.ruleMatches(s.rules.r1, Object.assign({}, tx, {amount: 99999}), ctx));
});

test('cofrinhos', () => {
    const p = {id: 'p', name: 'Viagem', accountId: 'poup', target: 600000, targetDate: '2026-12-31',
        events: [{date: '2026-01-01', amount: 100000}, {date: '2026-02-01', amount: -20000}]};
    const i = C.piggyInfo(p, '2026-10-23');
    assert.equal(i.saved, 80000);
    assert.equal(i.left, 520000);
    assert.equal(i.perMonth, Math.ceil(520000 / 2));
});

test('backup: exporta e importa sem perda', () => {
    const s = fixture();
    const json = JSON.stringify(C.exportData(s));
    const back = C.importData(json);
    assert.deepEqual(Object.keys(back.tx).sort(), Object.keys(s.tx).sort());
    assert.deepEqual(back.accounts.cc, s.accounts.cc);
    assert.throws(() => C.importData('{"app":"outro"}'), /não é um backup/);
});
