# Vagalume — finanças pessoais no Claude

Adaptação do [Firefly III](https://github.com/firefly-iii/firefly-iii) para rodar como página do Claude
(claude.ai), sem servidor próprio, sem PHP e sem backend. Interface em português do Brasil, valores em
reais (R$), datas em dd/mm/aaaa e formas de pagamento brasileiras (Pix, débito, crédito, dinheiro e
boleto). Pensado primeiro para o iPhone: abra no Safari e use "Adicionar à Tela de Início".

Não há bibliotecas externas: gráficos e formatação são feitos em JavaScript puro. Se alguma for
adicionada, deve vir de CDN permitida (cdnjs, jsdelivr ou unpkg) com versão fixa.

## O que foi reaproveitado do Firefly III

- **Modelo de dados:** contas por tipo (ativo, despesa, receita, passivo), lançamentos em partidas
  dobradas (despesa, receita, transferência), categorias, orçamentos com limite por mês,
  contas recorrentes, lançamentos recorrentes, cofrinhos, tags e regras (condições e ações).
- **Telas:** painel, lançamentos, contas, orçamentos, categorias, tags, contas recorrentes,
  recorrências, cofrinhos, regras e relatórios.
- **Regras de negócio:** o tipo do lançamento vem dos tipos das contas, os saldos são a soma das
  movimentações, contas de despesa e receita são criadas ao digitar um nome novo, a conta
  recorrente pode criar uma regra para vincular os pagamentos sozinha e as regras rodam em ordem,
  com opção de parar as seguintes.

Nada do PHP/Laravel roda aqui. A lógica foi reescrita em JavaScript em `core.js`, e cada chamada que
o Firefly III faria à sua API virou uma leitura ou gravação no banco de dados da página do Claude.

Acréscimo em relação ao Firefly III: cada lançamento (e cada recorrência) pode ter uma forma de
pagamento. As regras têm a condição "Forma de pagamento é" e a ação "Definir forma de pagamento", e
os relatórios mostram as despesas por forma de pagamento.

## Importação de extratos

Em **Mais → Importar extrato** (ou no ícone de envio da tela Lançamentos) você envia um arquivo OFX,
CSV ou QIF pelo celular, confere uma prévia e escolhe a conta de destino antes de importar.

- **Mapeamento do CSV**: cada coluna recebe um papel (data, descrição, valor com sinal, valor
  invertido, débito, crédito, indicador D/C, favorecido, categoria, identificador…), como no
  Firefly III Data Importer. O mapeamento fica salvo por banco e é reconhecido sozinho na próxima
  vez pelo cabeçalho do arquivo. No OFX, o app lembra para qual conta vai cada conta do banco.
- **Duplicados**, em camadas: identificador do banco (FITID do OFX ou coluna/combinação de colunas
  do CSV, o "pseudo identifier" do Data Importer); hash de conteúdo (conta, data, valor e descrição,
  como o `import_hash_v2` do Firefly III); linha idêntica no próprio arquivo (opcional); e "possível
  duplicado" para lançamentos já existentes na conta com o mesmo valor em até 3 dias (pega o que foi
  digitado à mão e o pagamento de fatura que aparece no extrato da conta e no do cartão). Duplicados
  chegam desmarcados na prévia.
- **Categoria sugerida**: as regras do app rodam em cada linha (como o `apply_rules` do Data
  Importer). Há um pacote de regras sugeridas ("UBER" → Transporte, "IFOOD" → Alimentação etc.)
  que vira regras comuns, editáveis em Mais → Regras. Sem regra, vale a categoria do arquivo e,
  por último, a de um lançamento parecido do histórico.
- **Forma de pagamento** é sugerida pela descrição (PIX, boleto, compra no débito, saque) e pela
  conta (cartão → crédito).
- Cada importação pode ser **desfeita** depois.

Arquivos de exemplo usados nos testes ficam em `tests/fixtures/`.

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| `index.html` | Estrutura da página e estilos (visual de app de iPhone, tema claro e escuro) |
| `core.js` | Regras de negócio puras: dinheiro, datas, saldos, orçamentos, contas recorrentes, recorrências, regras, relatórios, backup |
| `importer.js` | Leitura de OFX, QIF e CSV, mapeamento de colunas, duplicados e prévia da importação |
| `app.js` | Telas, formulários, gráficos e gravação no banco de dados do Claude |
| `tests/` | Testes — rode com `node --test claude-app/tests/core.test.js claude-app/tests/importer.test.js` |

## Onde os dados ficam

No banco de dados da página do Claude, em `data/users/<seu id>/`. A plataforma mantém essa área
privada: só você lê e grava, nem o dono da página nem o Claude enxergam. São um documento por tipo
de cadastro (`accounts`, `categories`, `budgets`, `bills`, `recurrences`, `piggies`, `rules`) e um
documento por mês de lançamentos (`tx-AAAA-MM`). Use **Mais → Backup** para exportar um `.json`.

Fora do claude.ai (por exemplo, abrindo o `index.html` direto no navegador), o app mostra dados de
exemplo e não salva nada.

## Diferenças em relação ao Firefly III

Ficaram de fora: multimoeda e câmbio, lançamentos divididos, anexos, webhooks, e-mails, importação
de extratos, vários usuários, API e grupos de regras. Os cofrinhos ficam ligados a uma conta só.
Lançamentos recorrentes são criados quando você abre o app, não por cron.

## Licenças e créditos

- **Firefly III** — Copyright (c) James Cole <james@firefly-iii.org> e colaboradores — AGPL-3.0.
- **Firefly III Data Importer** (https://github.com/firefly-iii/data-importer) — Copyright (c)
  James Cole e colaboradores — AGPL-3.0. Lógica portada em `importer.js`: papéis de coluna
  (`config/csv.php`), leitura de valores (`Converter/Amount*.php`, `BankDebitCredit.php`), escolha
  do valor (`Conversion/Task/Amount.php`), identificador combinado (`Configuration.php`) e remoção
  de linhas repetidas (`CSVFileProcessor.php`).
- **ezbookkeeping** (https://github.com/mayswind/ezbookkeeping) — Copyright (c) 2020-2026 MaysWind —
  licença MIT. Leitura de OFX 1.x/2.x, do decodificador SGML e de QIF portada em `importer.js`, que
  traz o aviso de copyright e o texto completo da licença MIT.

## Licença

Firefly III: Copyright (c) James Cole <james@firefly-iii.org> e colaboradores.
Modificações: Copyright (c) 2026 rcbortolini.

Este programa é software livre, distribuído sob a GNU Affero General Public License, versão 3 ou
posterior (veja o arquivo `LICENSE` na raiz do repositório). Como a AGPL exige, o app publicado
traz, na tela **Sobre**, o link para este código-fonte.
