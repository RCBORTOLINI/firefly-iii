/*
 * importer.js — leitura de extratos (OFX, QIF e CSV) e preparação da importação no Vagalume.
 *
 * Copyright (c) 2026 rcbortolini. Licenciado sob a GNU Affero General Public License,
 * versão 3 ou posterior (veja o arquivo LICENSE na raiz do repositório).
 *
 * Este arquivo junta código de dois projetos, convertido para JavaScript:
 *
 * 1. Firefly III Data Importer (https://github.com/firefly-iii/data-importer)
 *    Copyright (c) James Cole <james@firefly-iii.org> e colaboradores — AGPL-3.0.
 *    Daqui vêm: os papéis de coluna do CSV (config/csv.php), a leitura de valores
 *    (app/Services/CSV/Converter/Amount.php e AmountDebit/AmountCredit/AmountNegated),
 *    o indicador débito/crédito (BankDebitCredit.php), a escolha do valor e do tipo
 *    (Conversion/Task/Amount.php), o identificador combinado de colunas ("pseudo
 *    identifier", Configuration.php), a remoção de linhas repetidas
 *    (CSVFileProcessor::removeDuplicateLines) e o hash de conteúdo que o Firefly III
 *    usa para recusar duplicados (TransactionJournalFactory::hashArray).
 *
 * 2. ezbookkeeping (https://github.com/mayswind/ezbookkeeping)
 *    Copyright (c) 2020-2026 MaysWind (i@mayswind.net) — licença MIT, reproduzida abaixo.
 *    Daqui vêm: a leitura de OFX 1.x (SGML) e 2.x (XML) com o cabeçalho e a codificação
 *    (pkg/converters/ofx/ofx_data_reader.go), os campos do extrato (ofx_data.go), a
 *    conversão de cada transação, da data DTPOSTED e da descrição MEMO/NAME/PAYEE
 *    (ofx_transaction_data_table.go), o decodificador SGML sem tags de fechamento
 *    (pkg/converters/sgml/sgml_decoder.go) e a leitura de QIF (pkg/converters/qif).
 *
 *    MIT License
 *
 *    Copyright (c) 2020-2026 MaysWind (i@mayswind.net)
 *
 *    Permission is hereby granted, free of charge, to any person obtaining a copy
 *    of this software and associated documentation files (the "Software"), to deal
 *    in the Software without restriction, including without limitation the rights
 *    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *    copies of the Software, and to permit persons to whom the Software is
 *    furnished to do so, subject to the following conditions:
 *
 *    The above copyright notice and this permission notice shall be included in all
 *    copies or substantial portions of the Software.
 *
 *    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *    SOFTWARE.
 */
(function (root, factory) {
    const core = typeof module === 'object' && module.exports ? require('./core.js') : root.FFCore;
    const api = factory(core);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.FFImport = api;
    }
})(typeof self !== 'undefined' ? self : this, function (C) {
    'use strict';

    // ------------------------------------------------------------ codificação

    function latin1(u8) {
        let s = '';
        for (let i = 0; i < u8.length; i++) {
            s += String.fromCharCode(u8[i]);
        }
        return s;
    }

    /** Codificação declarada no cabeçalho do OFX 1.x (ENCODING/CHARSET) ou na declaração XML. */
    function declaredEncoding(head) {
        if (/^\s*OFXHEADER:/.test(head)) {
            const enc = (/ENCODING:\s*([^\r\n]+)/i.exec(head) || [])[1];
            const cs = ((/CHARSET:\s*([^\r\n]+)/i.exec(head) || [])[1] || '').trim().toLowerCase();
            const e = String(enc || '').trim().toLowerCase();
            if (e === 'unicode') {
                return 'utf-16le';
            }
            if (e === 'utf-8') {
                return 'utf-8';
            }
            if (/^\d+$/.test(cs)) {
                return 'windows-' + cs;
            }
            if (cs && cs !== 'none') {
                return cs;
            }
            return 'windows-1252';
        }
        const xml = /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(head);
        return xml ? xml[1].toLowerCase() : null;
    }

    /**
     * Bytes do arquivo → texto. Tenta UTF-8 estrito primeiro: muitos bancos declaram
     * CHARSET:1252 mas enviam UTF-8. Se não for UTF-8 válido, usa a codificação
     * declarada (como o ezbookkeeping) ou, sem declaração, windows-1252.
     */
    function decodeBytes(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
            return new TextDecoder('utf-8').decode(u8.subarray(3));
        }
        if (u8[0] === 0xff && u8[1] === 0xfe) {
            return new TextDecoder('utf-16le').decode(u8.subarray(2));
        }
        if (u8[0] === 0xfe && u8[1] === 0xff) {
            return new TextDecoder('utf-16be').decode(u8.subarray(2));
        }
        const declared = declaredEncoding(latin1(u8.subarray(0, 2048)));
        if (declared === 'utf-16le') {
            return new TextDecoder('utf-16le').decode(u8);
        }
        try {
            return new TextDecoder('utf-8', {fatal: true}).decode(u8);
        } catch (e) {
            try {
                return new TextDecoder(declared && declared !== 'utf-8' ? declared : 'windows-1252').decode(u8);
            } catch (e2) {
                return new TextDecoder('windows-1252').decode(u8);
            }
        }
    }

    function detectFormat(text, fileName) {
        const head = text.slice(0, 2048).replace(/^\s+/, '');
        const ext = String(fileName || '').toLowerCase().split('.').pop();
        if (/^OFXHEADER:/i.test(head) || /<OFX>/i.test(head) || /<\?OFX/i.test(head) || ext === 'ofx' || ext === 'qfx') {
            return 'ofx';
        }
        if (/^!(Type|Account)/i.test(head) || ext === 'qif') {
            return 'qif';
        }
        return 'csv';
    }

    // --------------------------------------------------------------- valores

    /** String decimal ("-1234.5") → centavos, sem passar por ponto flutuante. */
    function decimalToCents(str) {
        const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(str).trim());
        if (!m || (m[2] === '' && !m[3])) {
            return NaN;
        }
        const frac = (m[3] || '') + '000';
        let cents = parseInt(m[2] || '0', 10) * 100 + parseInt(frac.slice(0, 2), 10);
        if (+frac[2] >= 5) {
            cents += 1;
        }
        return m[1] === '-' ? -cents : cents;
    }

    // Porta de Amount::stripAmount (Data Importer). Acrescenta "R$"/"BRL" e o sinal no
    // fim ("1.234,56-" ou "1.234,56 D"), comum em extratos brasileiros.
    function stripAmount(value) {
        let v = String(value);
        let neg = false;
        if (v.startsWith('--')) {
            v = v.slice(2);
        }
        v = v.replace(/€|EUR|R\$|BRL/g, '').trim();
        if (/(-|\bD)$/i.test(v) && !/^-/.test(v)) {
            neg = true;
            v = v.replace(/\s*(-|D)$/i, '');
        }
        let str = v.replace(/[^\-().,0-9 ]/g, '');
        if (str.startsWith('(') && str.endsWith(')')) {
            str = '-' + str.slice(1, -1);
        }
        str = str.trim();
        return neg && str && !str.startsWith('-') ? '-' + str : str;
    }

    const decimalIsDot = (v) => v.length > 2 && (v[v.length - 3] === '.' || v.indexOf('.') > v.length - 3);
    const decimalIsComma = (v) => (v.length > 2 && v[v.length - 3] === ',') || ((v.match(/,/g) || []).length === 1 && v.startsWith('0,'));
    const altDecimal = (v) => v.length > 1 && (v[v.length - 2] === '.' || v[v.length - 2] === ',');

    /**
     * Porta de Amount::convert (Data Importer): descobre se o separador decimal é ponto ou
     * vírgula olhando a posição. Quando não dá para saber ("1.000"), usa o separador do
     * idioma reserva — aqui pt-BR, a vírgula, como o fallback_locale do Data Importer.
     * Devolve centavos (NaN se não for um número).
     */
    function parseAmount(value) {
        if (value == null || String(value).trim() === '') {
            return NaN;
        }
        let v = stripAmount(value);
        let decimal = null;
        if (decimalIsDot(v)) {
            decimal = '.';
        }
        if (decimalIsComma(v)) {
            decimal = ',';
        }
        if (altDecimal(v)) {
            decimal = v[v.length - 2];
        }
        if (v.endsWith('-')) {
            v = v.slice(0, -1);
        }
        if (v.endsWith('.') || v.endsWith(',')) {
            v = v.slice(0, -1);
        }
        if (decimal === null) {
            decimal = ',';
        }
        v = decimal === ',' ? v.replace(/[. ]/g, '').replace(',', '.') : v.replace(/[, ]/g, '');
        if (v.startsWith('.')) {
            v = '0' + v;
        }
        if (v.startsWith('-.')) {
            v = '-0' + v.slice(1);
        }
        return decimalToCents(v);
    }

    // Porta de BankDebitCredit::convert, com os termos usados por bancos brasileiros.
    const DEBIT_WORDS = ['d', 'a', 'dr', 'af', 'db', 'debet', 'debit', 's', 'dbit', 'charge', '(-)', 'out',
        'deb', 'debito', 'débito', 'saida', 'saída', '-'];

    function debitCreditSign(value) {
        return DEBIT_WORDS.includes(String(value || '').trim().toLowerCase()) ? -1 : 1;
    }

    // ----------------------------------------------------------------- datas

    const DATE_FORMATS = {
        dmy: 'dd/mm/aaaa',
        ymd: 'aaaa-mm-dd',
        mdy: 'mm/dd/aaaa',
        compact: 'aaaammdd',
    };

    /** Lê uma data num formato. Aceita / - . ' como separador e ignora a hora. */
    function parseDateWith(value, order) {
        let s = String(value || '').trim().split(/[\sT]/)[0];
        if (!s) {
            return null;
        }
        let y;
        let m;
        let d;
        if (order === 'compact') {
            const r = /^(\d{4})(\d{2})(\d{2})/.exec(s);
            if (!r) {
                return null;
            }
            [, y, m, d] = r;
        } else {
            s = s.replace(/'/g, '/').replace(/\s/g, '');
            const p = s.split(/[\/.\-]/);
            if (p.length !== 3 || p.some((x) => !/^\d+$/.test(x))) {
                return null;
            }
            if (order === 'ymd') {
                [y, m, d] = p;
            } else if (order === 'mdy') {
                [m, d, y] = p;
            } else {
                [d, m, y] = p;
            }
        }
        let yy = +y;
        if (String(y).length <= 2) {
            yy += 2000;
        }
        // Data Importer: ano antes de 1984 indica data sem ano; usa o ano atual.
        if (yy < 1984) {
            yy = new Date().getFullYear();
        }
        const iso = yy + '-' + String(+m).padStart(2, '0') + '-' + String(+d).padStart(2, '0');
        return C.isISODate(iso) ? iso : null;
    }

    /** Escolhe o formato que lê todas as amostras; empate fica com dd/mm/aaaa. */
    function guessDateFormat(values) {
        const sample = values.filter((v) => String(v || '').trim()).slice(0, 30);
        for (const order of ['dmy', 'ymd', 'mdy', 'compact']) {
            if (sample.length && sample.every((v) => parseDateWith(v, order))) {
                return order;
            }
        }
        return 'dmy';
    }

    // ------------------------------------------------------------------- OFX

    function decodeEntities(s) {
        return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (all, e) => {
            const k = e.toLowerCase();
            if (k[0] === '#') {
                return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
            }
            return {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}[k];
        });
    }

    /**
     * Lê OFX 1.x (SGML) e 2.x (XML) numa árvore. No SGML os campos não têm tag de fechamento
     * (<TRNAMT>-10.00), como trata o sgml_decoder do ezbookkeeping: uma tag seguida de texto
     * é um campo; uma tag seguida de outra tag abre um bloco, que termina no seu </TAG>.
     */
    function parseMarkupTree(text) {
        const start = text.search(/<OFX>/i);
        if (start < 0) {
            throw new Error('Não encontrei o bloco <OFX> no arquivo.');
        }
        const root = {name: '#root', children: []};
        const stack = [root];
        const re = /<(\/?)([A-Za-z0-9_.]+)[^>]*>([^<]*)/g;
        const body = text.slice(start);
        let m;
        while ((m = re.exec(body))) {
            const name = m[2].toUpperCase();
            const value = decodeEntities(m[3].trim());
            if (m[1]) {
                let idx = -1;
                for (let i = stack.length - 1; i > 0; i--) {
                    if (stack[i].name === name) {
                        idx = i;
                        break;
                    }
                }
                if (idx > 0) {
                    stack.length = idx;
                }
                continue;
            }
            if (value !== '') {
                stack[stack.length - 1].children.push({name, text: value});
            } else {
                const node = {name, children: []};
                stack[stack.length - 1].children.push(node);
                stack.push(node);
            }
        }
        return root;
    }

    function findAll(node, name, out) {
        const list = out || [];
        for (const c of node.children || []) {
            if (c.name === name) {
                list.push(c);
            }
            if (c.children) {
                findAll(c, name, list);
            }
        }
        return list;
    }

    /** Valor de um campo: primeiro entre os filhos diretos, depois em blocos internos. */
    function field(node, name) {
        if (!node) {
            return '';
        }
        const direct = (node.children || []).find((c) => c.name === name && c.text != null);
        if (direct) {
            return direct.text;
        }
        for (const c of node.children || []) {
            if (c.children && c.name !== 'STMTTRN') {
                const v = field(c, name);
                if (v) {
                    return v;
                }
            }
        }
        return '';
    }

    const child = (node, name) => (node ? (node.children || []).find((c) => c.name === name && c.children) : null) || null;

    /** DTPOSTED "AAAAMMDD[HHMMSS[.XXX]][[gmt:tz]]" → "AAAA-MM-DD" (porta de parseTransactionTimeAndTimeZone). */
    function parseOFXDate(s) {
        const v = String(s || '');
        if (v.length < 8 || !/^\d{8}$/.test(v.slice(0, 8))) {
            return null;
        }
        const iso = v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8);
        return C.isISODate(iso) ? iso : null;
    }

    /** TRNAMT aceita ponto ou vírgula decimal (ofx_transaction_data_table.go). */
    function parseOFXAmount(s) {
        return decimalToCents(String(s || '').trim().replace(/\s/g, '').replace(',', '.').replace(/^\+/, ''));
    }

    /**
     * Lê um OFX e devolve um extrato por conta encontrada. O sinal de TRNAMT decide entrada
     * ou saída (é o caminho do ezbookkeeping para tipos desconhecidos e o que funciona com
     * os bancos brasileiros); TRNTYPE ajuda a sugerir a forma de pagamento.
     */
    function parseOFX(text) {
        const tree = parseMarkupTree(text);
        const stmts = findAll(tree, 'STMTRS').concat(findAll(tree, 'CCSTMTRS'));
        if (!stmts.length) {
            throw new Error('O arquivo OFX não tem extrato de conta nem de cartão.');
        }
        return stmts.map((st) => {
            const card = st.name === 'CCSTMTRS';
            const acct = child(st, card ? 'CCACCTFROM' : 'BANKACCTFROM');
            const list = child(st, 'BANKTRANLIST');
            const bal = child(st, 'LEDGERBAL');
            const items = [];
            for (const tr of (list ? list.children : []).filter((c) => c.name === 'STMTTRN')) {
                const name = field(tr, 'NAME');
                const memo = field(tr, 'MEMO');
                const payee = child(tr, 'PAYEE');
                const payeeName = payee ? field(payee, 'NAME') : '';
                const ownName = (tr.children || []).find((c) => c.name === 'NAME' && c.text != null);
                items.push({
                    date: parseOFXDate(field(tr, 'DTPOSTED')),
                    amount: parseOFXAmount(field(tr, 'TRNAMT')),
                    externalId: field(tr, 'FITID'),
                    trnType: field(tr, 'TRNTYPE').toUpperCase(),
                    description: memo || (ownName ? ownName.text : '') || payeeName || name,
                    opposing: memo && ownName && ownName.text !== memo ? ownName.text : payeeName,
                    checkNum: field(tr, 'CHECKNUM'),
                    raw: {FITID: field(tr, 'FITID'), DTPOSTED: field(tr, 'DTPOSTED'), TRNAMT: field(tr, 'TRNAMT'), NAME: name, MEMO: memo},
                });
            }
            return {
                format: 'ofx',
                card,
                currency: field(st, 'CURDEF') || 'BRL',
                bankId: acct ? field(acct, 'BANKID') : '',
                branchId: acct ? field(acct, 'BRANCHID') : '',
                accountId: acct ? field(acct, 'ACCTID') : '',
                start: parseOFXDate(field(list, 'DTSTART')),
                end: parseOFXDate(field(list, 'DTEND')),
                ledgerBalance: bal ? parseOFXAmount(field(bal, 'BALAMT')) : null,
                items,
            };
        });
    }

    // ------------------------------------------------------------------- QIF

    const QIF_TX_HEADERS = ['!Type:Bank', '!Type:Cash', '!Type:CCard', '!Type:Oth A', '!Type:Oth L'];

    /** Porta de qif_data_reader.go: blocos de transação separados por "^". */
    function parseQIF(text, dateOrder) {
        const order = dateOrder || 'dmy';
        const lines = text.split(/\r?\n/);
        let header = '';
        let entry = [];
        const items = [];
        let card = false;
        for (const raw of lines) {
            const line = raw.replace(/\s+$/, '');
            if (!line) {
                continue;
            }
            if (line[0] === '!') {
                header = line;
                entry = [];
                if (line === '!Type:CCard') {
                    card = true;
                }
                continue;
            }
            if (line[0] === '^') {
                if (QIF_TX_HEADERS.includes(header) && entry.length) {
                    const t = {};
                    for (const l of entry) {
                        const k = l[0];
                        const v = l.slice(1).trim();
                        if (k === 'D') {
                            t.D = v;
                        } else if (k === 'T' || (k === 'U' && t.T == null)) {
                            t.T = v;
                        } else if (k === 'P') {
                            t.P = v;
                        } else if (k === 'M') {
                            t.M = v;
                        } else if (k === 'L') {
                            t.L = v;
                        } else if (k === 'N') {
                            t.N = v;
                        }
                    }
                    items.push({
                        date: parseDateWith(t.D, order),
                        amount: parseAmountQIF(t.T),
                        description: t.P || t.M || '',
                        opposing: t.P && t.M ? t.P : '',
                        notes: t.P && t.M ? t.M : '',
                        category: t.L && !/^\[.*\]$/.test(t.L) ? t.L.split(':')[0] : '',
                        externalId: t.N || '',
                        raw: t,
                    });
                }
                entry = [];
                continue;
            }
            if (header) {
                entry.push(line);
            }
        }
        if (!items.length) {
            throw new Error('Não encontrei lançamentos no arquivo QIF.');
        }
        return [{format: 'qif', card, items}];
    }

    /** No QIF a vírgula costuma ser separador de milhar ("-1,234.56"). */
    function parseAmountQIF(s) {
        const v = String(s || '').trim();
        if (/^-?[\d,]*\.\d{1,2}$/.test(v)) {
            return decimalToCents(v.replace(/,/g, ''));
        }
        return parseAmount(v);
    }

    // ------------------------------------------------------------------- CSV

    /** CSV no padrão RFC 4180 (aspas, aspas duplicadas e quebras de linha dentro de aspas). */
    function parseCSV(text, delimiter) {
        const rows = [];
        let row = [];
        let fieldText = '';
        let quoted = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quoted) {
                if (ch === '"') {
                    if (text[i + 1] === '"') {
                        fieldText += '"';
                        i++;
                    } else {
                        quoted = false;
                    }
                } else {
                    fieldText += ch;
                }
            } else if (ch === '"' && fieldText.trim() === '') {
                quoted = true;
                fieldText = '';
            } else if (ch === delimiter) {
                row.push(fieldText);
                fieldText = '';
            } else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && text[i + 1] === '\n') {
                    i++;
                }
                row.push(fieldText);
                rows.push(row);
                row = [];
                fieldText = '';
            } else {
                fieldText += ch;
            }
        }
        if (fieldText !== '' || row.length) {
            row.push(fieldText);
            rows.push(row);
        }
        return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
    }

    /** Escolhe entre ; , e tab pelo separador que dá o mesmo número de colunas nas primeiras linhas. */
    function detectDelimiter(text) {
        const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 15);
        let best = ',';
        let bestScore = -1;
        for (const d of [';', ',', '\t', '|']) {
            const counts = lines.map((l) => (parseCSV(l, d)[0] || []).length);
            const freq = {};
            for (const c of counts) {
                freq[c] = (freq[c] || 0) + 1;
            }
            const mode = +Object.keys(freq).sort((a, b) => freq[b] - freq[a] || b - a)[0] || 0;
            const score = mode > 1 ? freq[mode] * 100 + mode : 0;
            if (score > bestScore) {
                best = d;
                bestScore = score;
            }
        }
        return best;
    }

    /** Papéis de coluna (subconjunto de import_roles do Data Importer, com rótulos em português). */
    const ROLES = {
        _ignore: {label: 'Ignorar'},
        date_transaction: {label: 'Data'},
        description: {label: 'Descrição', append: true},
        note: {label: 'Observação', append: true},
        amount: {label: 'Valor (com sinal)'},
        amount_negated: {label: 'Valor (sinal invertido)'},
        amount_debit: {label: 'Valor de saída (débito)'},
        amount_credit: {label: 'Valor de entrada (crédito)'},
        'generic-debit-credit': {label: 'Indicador D/C'},
        'opposing-name': {label: 'Favorecido ou pagador'},
        'category-name': {label: 'Categoria'},
        'tags-comma': {label: 'Tags (vírgula)'},
        'external-id': {label: 'Identificador único'},
        payment: {label: 'Forma de pagamento'},
    };

    const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

    /** Sugere o papel de cada coluna pelo nome do cabeçalho (ou, sem cabeçalho, pelos valores). */
    function guessRoles(header, samples) {
        const roles = [];
        const used = new Set();
        const n = Math.max(header ? header.length : 0, ...samples.map((r) => r.length));
        for (let i = 0; i < n; i++) {
            const h = fold(header ? header[i] : '');
            const vals = samples.map((r) => r[i] || '').filter(Boolean);
            let role = '_ignore';
            if (h) {
                if (/saldo|balance/.test(h)) {
                    role = '_ignore';
                } else if (/^(data|date|dt)\b|data (do )?lanc|data mov/.test(h)) {
                    role = 'date_transaction';
                } else if (/debito|saida|saque|withdraw/.test(h) && /valor|r\$|amount|^debito|^saida/.test(h + ' valor')) {
                    role = 'amount_debit';
                } else if (/credito|entrada|deposit/.test(h)) {
                    role = 'amount_credit';
                } else if (/valor|amount|quantia|montante|^r\$/.test(h)) {
                    role = 'amount';
                } else if (/^(d\/c|c\/d|dc|cd|natureza|tipo)$/.test(h) && vals.every((v) => /^[dc]$/i.test(v) || /deb|cred/i.test(v))) {
                    role = 'generic-debit-credit';
                } else if (/descri|histor|lancamento|estabelecimento|title|titulo|memo|detalhe/.test(h)) {
                    role = 'description';
                } else if (/favorecido|beneficiario|destinatario|pagador|remetente|payee|contraparte/.test(h)) {
                    role = 'opposing-name';
                } else if (/categoria|category/.test(h)) {
                    role = 'category-name';
                } else if (/identificador|documento|^id$|nsu|autentica|^doc|^n[ºo°]?\.? ?doc/.test(h)) {
                    role = 'external-id';
                } else if (/obs|nota|note/.test(h)) {
                    role = 'note';
                }
            } else if (vals.length && vals.every((v) => parseDateWith(v, guessDateFormat(vals)))) {
                role = 'date_transaction';
            } else if (vals.length && vals.every((v) => /^[-+(]?\s*(R\$)?\s*[\d.,]+\)?\s*[-D]?$/i.test(v))) {
                role = 'amount';
            } else if (vals.length && vals.some((v) => /[a-z]{3}/i.test(v))) {
                role = 'description';
            }
            if (['date_transaction', 'amount', 'external-id'].includes(role) && used.has(role)) {
                role = '_ignore';
            }
            used.add(role);
            roles.push(role);
        }
        return roles;
    }

    function headerSignature(header) {
        return (header || []).map(fold).join('|');
    }

    /**
     * Linhas do CSV → itens de extrato, como o Data Importer: o valor vem da primeira coluna
     * válida entre valor, débito, crédito e valor invertido (Task/Amount.php), multiplicado
     * pelo indicador D/C; descrição e observação juntam várias colunas (append_value).
     */
    function csvItems(rows, profile) {
        const roles = profile.roles || [];
        const start = (profile.skipRows || 0) + (profile.hasHeader ? 1 : 0);
        const items = [];
        const errors = [];
        for (let r = start; r < rows.length; r++) {
            const row = rows[r];
            const get = (role) => roles.map((x, i) => (x === role ? row[i] : null)).filter((v) => v != null && v !== '');
            const dateRaw = get('date_transaction')[0];
            const date = parseDateWith(dateRaw, profile.dateFormat || 'dmy');
            const valid = (v) => {
                const c = parseAmount(v);
                return Number.isFinite(c) && c !== 0 ? c : null;
            };
            let amount = null;
            const a = get('amount').map(valid).find((x) => x != null);
            const d = get('amount_debit').map(valid).find((x) => x != null);
            const c = get('amount_credit').map(valid).find((x) => x != null);
            const n = get('amount_negated').map(valid).find((x) => x != null);
            if (a != null) {
                amount = a;
            } else if (d != null) {
                amount = -Math.abs(d);
            } else if (c != null) {
                amount = Math.abs(c);
            } else if (n != null) {
                amount = -n;
            }
            const indicator = get('generic-debit-credit')[0];
            if (amount != null && indicator != null) {
                amount = Math.abs(amount) * debitCreditSign(indicator);
            }
            if (!date || amount == null) {
                // Linhas de saldo, totais e rodapés não têm data ou valor: ficam de fora.
                if (row.filter(Boolean).length > 1) {
                    errors.push({line: r + 1, reason: !date ? 'data não reconhecida' : 'valor não reconhecido', raw: row});
                }
                continue;
            }
            const idCols = profile.idColumns || [];
            const externalId = idCols.length ? idCols.map((i) => row[i] || '').join('|') : (get('external-id')[0] || '');
            items.push({
                date, amount,
                description: get('description').join(' ').replace(/\s+/g, ' ').trim(),
                notes: get('note').join(' ').trim(),
                opposing: get('opposing-name')[0] || '',
                category: get('category-name')[0] || '',
                tags: get('tags-comma').join(','),
                payment: get('payment')[0] || '',
                externalId,
                raw: row,
            });
        }
        return {items, errors};
    }

    // ------------------------------------------------------- duplicados e hash

    async function sha256(text) {
        const data = new TextEncoder().encode(text);
        const buf = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    /** Hash de conteúdo, no espírito do import_hash_v2 do Firefly III (hashArray). */
    function importHash(accountId, item) {
        return sha256(JSON.stringify({account: accountId, date: item.date, amount: item.amount, description: fold(item.description)}));
    }

    /** Valor do lançamento visto pela conta: + entrou, − saiu. */
    function signedFor(t, accountId) {
        if (t.dest === accountId) {
            return t.amount;
        }
        if (t.source === accountId) {
            return -t.amount;
        }
        return null;
    }

    /**
     * Marca duplicados, em camadas:
     * 1. identificador do banco (FITID do OFX ou coluna/combinação de colunas do CSV) já importado;
     * 2. mesmo hash de conteúdo já importado (conta, data, valor e descrição);
     * 3. linha idêntica repetida no próprio arquivo (opcional, como ignore_duplicate_lines);
     * 4. possível duplicado: lançamento já existente na conta com o mesmo valor até 3 dias de distância
     *    (pega o que foi digitado à mão antes da importação).
     */
    async function markDuplicates(state, items, accountId, opts) {
        const o = opts || {};
        const ext = new Map();
        const hashes = new Map();
        const pool = [];
        for (const t of Object.values(state.tx)) {
            if (t.externalId) {
                ext.set(t.externalId, t);
            }
            if (t.importHash) {
                hashes.set(t.importHash, t);
            }
            const s = signedFor(t, accountId);
            if (s != null) {
                pool.push({t, s});
            }
        }
        const seenLines = new Set();
        const used = new Set();
        const out = [];
        for (const it of items) {
            const hash = await importHash(accountId, it);
            const extKey = it.externalId ? accountId + ':' + it.externalId : null;
            let dup = null;
            if (extKey && ext.has(extKey)) {
                dup = {kind: 'id', tx: ext.get(extKey)};
            } else if (hashes.has(hash)) {
                dup = {kind: 'conteudo', tx: hashes.get(hash)};
            } else if (o.ignoreDuplicateLines && seenLines.has(hash)) {
                dup = {kind: 'arquivo'};
            } else {
                // Lançamentos digitados à mão: até 3 dias de diferença. Já importados desta conta
                // (de outro arquivo, com descrição diferente): só no mesmo dia.
                const hit = pool.find((p) => !used.has(p.t.id) && p.s === it.amount
                    && Math.abs(C.diffDays(p.t.date, it.date)) <= (p.t.importAccountId === accountId ? 0 : 3));
                if (hit) {
                    used.add(hit.t.id);
                    dup = {kind: 'possivel', tx: hit.t};
                }
            }
            seenLines.add(hash);
            out.push(Object.assign({}, it, {hash, extKey, dup}));
        }
        return out;
    }

    // ------------------------------------------------- sugestões e regras

    /** Forma de pagamento pela descrição e pelo tipo da transação no OFX. */
    function inferPayment(desc, account, trnType) {
        if (account && account.kind === 'cartao') {
            return 'credito';
        }
        const d = fold(desc);
        if (/\bpix\b/.test(d)) {
            return 'pix';
        }
        if (/boleto|bloqueto|cobranca|pagto? titulo|pag titulo|pagamento de titulo/.test(d)) {
            return 'boleto';
        }
        if (/\bsaque\b/.test(d) || trnType === 'ATM' || trnType === 'CASH') {
            return 'dinheiro';
        }
        if (/compra (no )?(cartao )?deb|cartao de debito|\bdebito\b|visa electron|maestro|elo deb/.test(d) || trnType === 'POS') {
            return 'debito';
        }
        return null;
    }

    const NOISE = [
        /^(pix|transf(erencia)?|ted|doc)\s+(enviad[oa]|recebid[oa]|env|rec)\b[\s\-:]*/,
        /^(compra|pagamento|pagto|pag|pgto)\s+(com\s+)?(cartao\s+)?(de\s+)?(debito|credito|deb|cred|boleto)?\b[\s\-:]*/,
        /^(pag\*|pg\s*\*|mp\s*\*|ifd\*|ec\s*\*)/,
        /^(debito automatico|deb aut|deb\.? autom\.?)\b[\s\-:]*/,
        /\b\d{2}\/\d{2}(\/\d{2,4})?\b/g,
        /\b\d{2}:\d{2}\b/g,
        /\b(\d[\d.\-\/]{5,})\b/g,
    ];

    /** Nome da contraparte a partir da descrição do banco ("PAG*UBER TRIP" → "Uber Trip"). */
    function cleanCounterparty(desc) {
        let d = fold(desc).replace(/\s+/g, ' ');
        for (const re of NOISE) {
            d = d.replace(re, ' ');
        }
        d = d.replace(/[*_;|]+/g, ' ').replace(/\s+-\s+.*$/, '').replace(/[\s,.:\-]+$/, '').replace(/\s+/g, ' ').trim();
        if (!d || d.length < 2) {
            return '';
        }
        const small = ['de', 'da', 'do', 'das', 'dos', 'e'];
        return d.slice(0, 40).split(' ').map((w, i) => (i && small.includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
    }

    /** Chave para achar lançamentos parecidos no histórico (sem números e datas). */
    function similarityKey(desc) {
        return fold(desc).replace(/[\d.,\/:*\-]+/g, ' ').replace(/\b(pix|compra|pagamento|pag|pgto|cartao|debito|credito|enviado|recebido|transferencia)\b/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }

    /** Pacote de regras sugeridas para extratos brasileiros (o usuário pode editar tudo depois). */
    const STARTER_RULES = [
        {title: 'Transporte por aplicativo e combustível', category: 'Transporte',
            words: ['uber', '99app', '99 pop', '99 tecnologia', '99*', 'cabify', 'posto', 'combustivel', 'ipiranga', 'shell', 'petrobras', 'estacionamento', 'sem parar', 'conectcar', 'veloe']},
        {title: 'Alimentação e mercado', category: 'Alimentação',
            words: ['ifood', 'ifd*', 'rappi', 'restaurante', 'padaria', 'panificadora', 'lanchonete', 'supermercado', 'mercado', 'carrefour', 'pao de acucar', 'assai', 'atacadao', 'hortifruti', 'acougue']},
        {title: 'Farmácia e saúde', category: 'Saúde',
            words: ['farmacia', 'drogaria', 'droga raia', 'drogasil', 'pague menos', 'unimed', 'hospital', 'laboratorio', 'clinica', 'odonto']},
        {title: 'Assinaturas e streaming', category: 'Assinaturas',
            words: ['netflix', 'spotify', 'disney', 'prime video', 'amazon prime', 'hbo', 'max.com', 'globoplay', 'youtube', 'apple.com', 'google one', 'deezer']},
        {title: 'Contas da casa', category: 'Contas da casa',
            words: ['enel', 'cemig', 'copel', 'light', 'sabesp', 'comgas', 'energia', 'saneamento', 'vivo', 'claro', 'tim ', 'internet', 'condominio']},
        {title: 'Compras online', category: 'Compras',
            words: ['amazon', 'mercadolivre', 'mercado livre', 'shopee', 'magalu', 'magazine luiza', 'americanas', 'aliexpress', 'shein']},
        {title: 'Tarifas e juros do banco', category: 'Tarifas bancárias',
            words: ['tarifa', 'iof', 'anuidade', 'juros', 'encargos', 'cesta de servicos', 'pacote de servicos']},
        {title: 'Salário', category: 'Salário', words: ['salario', 'folha de pagamento', 'pagto salario', 'proventos']},
    ];

    // ------------------------------------------------------------- prévia

    const CP = '__cp:';
    const CARD_PAYMENT = /pagamento.{0,12}fatura|pgto.{0,6}fatura|pagto.{0,6}fatura|pag fatura|fatura (do )?cartao|pagamento (do )?cartao|pagto cartao/;

    /** Contexto das regras na prévia: contas de contraparte ainda não existem e vão como "__cp:Nome". */
    function previewCtx(state) {
        return {
            accName: (id) => (String(id).startsWith(CP) ? id.slice(CP.length) : state.accounts[id] ? state.accounts[id].name : ''),
            ensureAccount: (name) => CP + String(name).trim(),
        };
    }

    /**
     * Itens já marcados por markDuplicates → linhas da prévia com o lançamento sugerido.
     * A categoria vem das regras (como o apply_rules do Data Importer); sem regra, da coluna
     * de categoria do arquivo; sem nenhuma das duas, do lançamento mais recente parecido.
     */
    function prepareRows(state, items, accountId, opts) {
        const o = opts || {};
        const account = state.accounts[accountId];
        const own = Object.values(state.accounts).filter((a) => C.isOwn(a) && a.active !== false && a.id !== accountId);
        const corrente = own.find((a) => a.kind === 'corrente') || own.find((a) => C.groupOf(a) === 'ativo' && a.kind !== 'cartao');
        const cartao = own.find((a) => a.kind === 'cartao');
        const ctx = previewCtx(state);
        const history = new Map();
        for (const t of C.txInRange(state, null, null)) {
            const k = similarityKey(t.description);
            if (k && t.categoryId && !history.has(k)) {
                history.set(k, t.categoryId);
            }
        }
        const catByName = new Map(Object.values(state.categories).map((c) => [fold(c.name), c.id]));
        const payByName = {pix: 'pix', debito: 'debito', credito: 'credito', dinheiro: 'dinheiro', boleto: 'boleto'};
        return items.map((it, idx) => {
            const out = it.amount < 0;
            const amount = Math.abs(it.amount);
            const desc = String(it.description || '').trim() || it.opposing || 'Sem descrição';
            const name = it.opposing || cleanCounterparty(desc) || 'Diversos';
            const d = fold(desc);
            let type = out ? 'retirada' : 'deposito';
            let source = out ? accountId : CP + name;
            let dest = out ? CP + name : accountId;
            const isCardPayment = CARD_PAYMENT.test(d) || (account && account.kind === 'cartao' && !out && /pagamento|pgto|pagto/.test(d));
            if (isCardPayment) {
                const other = account && account.kind === 'cartao' ? corrente : cartao;
                if (other) {
                    type = 'transferencia';
                    source = out ? accountId : other.id;
                    dest = out ? other.id : accountId;
                }
            }
            let tx = {
                type, date: it.date, amount, description: desc, source, dest,
                categoryId: null, budgetId: null, billId: null,
                tags: C.cleanTags(it.tags || ''), notes: it.notes || '',
                paymentMethod: payByName[fold(it.payment)] || inferPayment(desc, account, it.trnType),
                externalId: it.extKey || null, importHash: it.hash, importAccountId: accountId,
            };
            if (type === 'transferencia') {
                tx.paymentMethod = null;
            }
            let catSource = null;
            let ruleTitles = [];
            if (o.applyRules !== false && type !== 'transferencia') {
                const res = C.applyRules(state, tx, ctx, {event: 'criar'});
                tx = res.tx;
                ruleTitles = res.applied.map((id) => (state.rules[id] ? state.rules[id].title : '')).filter(Boolean);
                if (tx.categoryId && res.applied.length) {
                    catSource = 'regra';
                }
            }
            if (!tx.categoryId && it.category) {
                const id = catByName.get(fold(it.category));
                if (id) {
                    tx.categoryId = id;
                } else {
                    tx.categoryName = it.category;
                }
                catSource = 'arquivo';
            }
            if (!tx.categoryId && !tx.categoryName && type !== 'transferencia') {
                const hit = history.get(similarityKey(desc));
                if (hit) {
                    tx.categoryId = hit;
                    catSource = 'historico';
                }
            }
            return {key: idx, item: it, tx, include: !it.dup, dup: it.dup, catSource, ruleTitles, cardPayment: isCardPayment};
        });
    }

    return {
        CP, previewCtx, prepareRows,
        decodeBytes, detectFormat, decimalToCents, parseAmount, debitCreditSign,
        DATE_FORMATS, parseDateWith, guessDateFormat,
        parseMarkupTree, parseOFX, parseOFXDate, parseQIF,
        parseCSV, detectDelimiter, ROLES, guessRoles, headerSignature, csvItems,
        sha256, importHash, markDuplicates, signedFor,
        inferPayment, cleanCounterparty, similarityKey, fold, STARTER_RULES,
    };
});
