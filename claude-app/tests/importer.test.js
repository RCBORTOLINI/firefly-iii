// Testes da importação de extratos. Rode com: node --test claude-app/tests/importer.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../core.js');
const I = require('../importer.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

function state() {
    const s = C.emptyState();
    s.accounts.cc = {id: 'cc', name: 'Conta corrente', kind: 'corrente', openingBalance: 0};
    s.accounts.card = {id: 'card', name: 'Cartão', kind: 'cartao', openingBalance: 0};
    s.accounts.merc = {id: 'merc', name: 'Mercado', kind: 'despesa'};
    s.categories.transp = {id: 'transp', name: 'Transporte'};
    s.categories.saude = {id: 'saude', name: 'Saúde'};
    s.rules.uber = {
        id: 'uber', title: 'Uber', active: true, strict: false, order: 1,
        triggers: [{type: 'descricao_contem', value: 'uber'}], actions: [{type: 'definir_categoria', value: 'transp'}],
    };
    return s;
}

test('valores no estilo do Data Importer, com os formatos brasileiros', () => {
    const cases = {
        '1.234,56': 123456, '1,234.56': 123456, '-45,90': -4590, '1.000': 100000, '(12,50)': -1250,
        '12,50-': -1250, 'R$ 1.234,56 D': -123456, '0,5': 50, '7500.00': 750000, '-1.800,00': -180000, '45': 4500,
    };
    for (const [input, cents] of Object.entries(cases)) {
        assert.equal(I.parseAmount(input), cents, input);
    }
    assert.ok(Number.isNaN(I.parseAmount('')));
    assert.equal(I.debitCreditSign('D'), -1);
    assert.equal(I.debitCreditSign('Débito'), -1);
    assert.equal(I.debitCreditSign('C'), 1);
});

test('datas: formatos e adivinhação', () => {
    assert.equal(I.parseDateWith('05/10/2026', 'dmy'), '2026-10-05');
    assert.equal(I.parseDateWith('05/10/2026 14:33', 'dmy'), '2026-10-05');
    assert.equal(I.parseDateWith("08/10'26", 'dmy'), '2026-10-08');
    assert.equal(I.parseDateWith('2026-10-03', 'ymd'), '2026-10-03');
    assert.equal(I.parseDateWith('20261003', 'compact'), '2026-10-03');
    assert.equal(I.parseDateWith('31/02/2026', 'dmy'), null);
    assert.equal(I.guessDateFormat(['2026-10-03', '2026-10-15']), 'ymd');
    assert.equal(I.guessDateFormat(['05/10/2026', '21/10/2026']), 'dmy');
    assert.equal(I.guessDateFormat(['10/21/2026']), 'mdy');
});

test('OFX 1.x (SGML, windows-1252): campos sem fechamento e acentos', () => {
    const text = I.decodeBytes(fixture('extrato-conta-corrente.ofx'));
    assert.equal(I.detectFormat(text, 'x.ofx'), 'ofx');
    const [st] = I.parseOFX(text);
    assert.equal(st.card, false);
    assert.equal(st.accountId, '56789-0');
    assert.equal(st.bankId, '0001');
    assert.equal(st.start, '2026-10-01');
    assert.equal(st.ledgerBalance, 400645);
    assert.equal(st.items.length, 8);
    const [sal, boleto, uber, farm] = st.items;
    assert.deepEqual([sal.date, sal.amount, sal.externalId], ['2026-10-05', 750000, '202610050001']);
    assert.equal(boleto.amount, -180000);
    assert.equal(uber.amount, -4590, 'TRNAMT com vírgula decimal');
    assert.equal(farm.description, 'COMPRA CARTAO DEB FARMÁCIA SÃO JOÃO', 'MEMO tem prioridade e os acentos chegam certos');
    assert.equal(farm.opposing, 'DROGARIA SAO JOAO');
    assert.equal(farm.trnType, 'POS');
});

test('OFX 2.x (XML) de cartão de crédito', () => {
    const text = I.decodeBytes(fixture('fatura-cartao.ofx'));
    const [st] = I.parseOFX(text);
    assert.equal(st.card, true);
    assert.equal(st.accountId, '5555********1234');
    assert.equal(st.items.length, 5);
    assert.equal(st.items[0].description, 'Supermercado Bom Preço');
    assert.equal(st.items[2].description, 'Spotify & Co');
    assert.equal(st.items[3].amount, 125040);
    assert.equal(st.items[4].description, 'Parcela 1/3');
    assert.equal(st.items[4].opposing, 'MERCADOLIVRE*LOJA');
});

test('OFX inválido dá erro em português', () => {
    assert.throws(() => I.parseOFX('qualquer coisa'), /bloco <OFX>/);
});

test('QIF', () => {
    const text = I.decodeBytes(fixture('extrato.qif'));
    assert.equal(I.detectFormat(text, 'a.qif'), 'qif');
    const [st] = I.parseQIF(text, 'dmy');
    assert.equal(st.items.length, 2);
    assert.deepEqual([st.items[0].date, st.items[0].amount, st.items[0].category], ['2026-10-05', 750000, 'Salário']);
    assert.deepEqual([st.items[1].date, st.items[1].amount], ['2026-10-08', -4590]);
});

test('CSV: separador, aspas, papéis sugeridos e linhas de saldo ignoradas', () => {
    const text = I.decodeBytes(fixture('extrato-conta.csv'));
    assert.equal(I.detectFormat(text, 'extrato.csv'), 'csv');
    const delim = I.detectDelimiter(text);
    assert.equal(delim, ';');
    const rows = I.parseCSV(text, delim);
    assert.equal(rows[4][1], 'PAG*UBER TRIP; 08/10', 'ponto e vírgula dentro de aspas');
    const roles = I.guessRoles(rows[0], rows.slice(1, 6));
    assert.deepEqual(roles, ['date_transaction', 'description', '_ignore', 'amount', '_ignore']);
    const profile = {hasHeader: true, dateFormat: I.guessDateFormat(rows.slice(1).map((r) => r[0])), roles};
    const {items, errors} = I.csvItems(rows, profile);
    assert.equal(items.length, 6);
    assert.equal(errors.length, 2, 'SALDO ANTERIOR e SALDO DO DIA');
    assert.equal(items[1].amount, -180000);
    assert.equal(items[5].amount, 35000);
});

test('CSV: débito/crédito em colunas, indicador D/C, valor invertido e identificador combinado', () => {
    const rows = [['Data', 'Histórico', 'Débito', 'Crédito'], ['01/10/2026', 'A', '10,00', ''], ['02/10/2026', 'B', '', '5,00']];
    assert.deepEqual(I.guessRoles(rows[0], rows.slice(1)), ['date_transaction', 'description', 'amount_debit', 'amount_credit']);
    let r = I.csvItems(rows, {hasHeader: true, roles: ['date_transaction', 'description', 'amount_debit', 'amount_credit']});
    assert.deepEqual(r.items.map((x) => x.amount), [-1000, 500]);
    r = I.csvItems([['01/10/2026', 'X', '10,00', 'D'], ['01/10/2026', 'Y', '10,00', 'C']],
        {roles: ['date_transaction', 'description', 'amount', 'generic-debit-credit'], idColumns: [0, 1]});
    assert.deepEqual(r.items.map((x) => x.amount), [-1000, 1000]);
    assert.equal(r.items[0].externalId, '01/10/2026|X');
    const nu = I.parseCSV(I.decodeBytes(fixture('fatura-cartao.csv')), ',');
    r = I.csvItems(nu, {hasHeader: true, dateFormat: 'ymd', roles: ['date_transaction', 'description', 'amount_negated']});
    assert.deepEqual(r.items.map((x) => x.amount), [-23056, -5800, 125040, -14990]);
});

test('duplicados: identificador, hash de conteúdo, linha repetida e possível duplicado', async () => {
    const s = state();
    const items = [
        {date: '2026-10-08', amount: -4590, description: 'PAG*UBER TRIP', externalId: 'F1'},
        {date: '2026-10-09', amount: -8735, description: 'FARMACIA', externalId: 'F2'},
        {date: '2026-10-10', amount: -1000, description: 'CAFE', externalId: ''},
        {date: '2026-10-10', amount: -1000, description: 'CAFE', externalId: ''},
        {date: '2026-10-12', amount: -12000, description: 'PIX MARIA', externalId: 'F5'},
    ];
    s.tx.a = {id: 'a', date: '2026-10-08', amount: 4590, source: 'cc', dest: 'merc', type: 'retirada', externalId: 'cc:F1', importAccountId: 'cc'};
    s.tx.b = {id: 'b', date: '2026-10-07', amount: 8735, source: 'cc', dest: 'merc', type: 'retirada', description: 'Remédio'};
    let out = await I.markDuplicates(s, items, 'cc');
    assert.deepEqual(out.map((x) => x.dup && x.dup.kind), ['id', 'possivel', null, null, null]);
    out = await I.markDuplicates(s, items, 'cc', {ignoreDuplicateLines: true});
    assert.equal(out[3].dup.kind, 'arquivo');
    s.tx.c = {id: 'c', date: '2026-10-12', amount: 12000, source: 'cc', dest: 'merc', type: 'retirada', importHash: out[4].hash, importAccountId: 'cc'};
    out = await I.markDuplicates(s, items.map((x) => Object.assign({}, x, {externalId: ''})), 'cc');
    assert.equal(out[4].dup.kind, 'conteudo');
    assert.equal(out[0].dup.kind, 'possivel', 'outro arquivo do mesmo banco, sem FITID: mesmo dia e valor');
    out = await I.markDuplicates(s, [{date: '2026-10-09', amount: -4590, description: 'UBER', externalId: ''}], 'cc');
    assert.equal(out[0].dup, null, 'já importado desta conta só conta como possível duplicado no mesmo dia');
});

test('prévia: regras, histórico, forma de pagamento, contraparte e pagamento de fatura', async () => {
    const s = state();
    s.tx.old = {id: 'old', date: '2026-09-01', amount: 5000, source: 'cc', dest: 'merc', type: 'retirada', description: 'COMPRA CARTAO DEB FARMACIA SAO JOAO 01/09', categoryId: 'saude'};
    const [st] = I.parseOFX(I.decodeBytes(fixture('extrato-conta-corrente.ofx')));
    const marked = await I.markDuplicates(s, st.items, 'cc');
    const rows = I.prepareRows(s, marked, 'cc', {applyRules: true});
    const by = (txt) => rows.find((r) => r.tx.description.includes(txt));
    const uber = by('UBER');
    assert.equal(uber.tx.categoryId, 'transp');
    assert.equal(uber.catSource, 'regra');
    assert.deepEqual(uber.ruleTitles, ['Uber']);
    assert.equal(uber.tx.dest, I.CP + 'Uber Trip');
    const farm = by('FARMÁCIA');
    assert.equal(farm.tx.categoryId, 'saude');
    assert.equal(farm.catSource, 'historico');
    assert.equal(farm.tx.paymentMethod, 'debito');
    assert.equal(farm.tx.dest, I.CP + 'DROGARIA SAO JOAO');
    assert.equal(by('PIX').tx.paymentMethod, 'pix');
    assert.equal(by('PIX').tx.dest, I.CP + 'Maria da Conceicao');
    assert.equal(by('BOLETO').tx.paymentMethod, 'boleto');
    assert.equal(by('SAQUE').tx.paymentMethod, 'dinheiro');
    const fatura = by('FATURA');
    assert.equal(fatura.tx.type, 'transferencia');
    assert.deepEqual([fatura.tx.source, fatura.tx.dest], ['cc', 'card']);
    const sal = by('SALARIO');
    assert.equal(sal.tx.type, 'deposito');
    assert.equal(sal.tx.dest, 'cc');
    assert.ok(rows.every((r) => r.include));
});

test('contraparte limpa a partir da descrição do banco', () => {
    assert.equal(I.cleanCounterparty('PAG*UBER TRIP 08/10'), 'Uber Trip');
    assert.equal(I.cleanCounterparty('PIX ENVIADO 12/10 MARIA DA CONCEIÇÃO'), 'Maria da Conceicao');
    assert.equal(I.cleanCounterparty('COMPRA CARTAO DEB PADARIA BOM PAO'), 'Padaria Bom Pao');
    assert.equal(I.cleanCounterparty('12/10'), '');
});
