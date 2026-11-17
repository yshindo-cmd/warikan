(() => {
  'use strict';

  /* ========== 設定 ========== */
  const MIN_MEMBERS = 2;
  const MAX_MEMBERS = 30;
  const DEFAULT_MEMBERS = 4;

  const DESCRIPTIONS = {
    equal: 'みんなで均等に割る、いちばん簡単な方法です。立て替えた人だけ、金額を入れてください。',
    exclude: 'アルコール代やガソリン代など、払わなくていい人がいる項目があるときに使います。',
    household: '家族ごとにまとめて割ります。大人と子どもの人数を入れると、子どもの負担を少なくして計算できます。'
  };

  /* ========== 清算ロジック（画面とは独立） ==========
   * paid:    各人が立て替えた金額（整数円）の配列
   * weights: 各人の口数（整数）の配列。全員平等なら全員1
   * unit:    お金を動かす単位（1 / 10 / 100円）
   *
   * ・負担額 = 総額 × 口数 ÷ 総口数 を、unit の単位で切り捨てる（誰も計算上の額より多く負担しない）
   * ・払う人は、不足額を unit の単位で切り捨てた金額を払う
   * ・受け取る人の上限は、受取額を unit の単位で切り上げた金額
   *   → 送金額はすべて unit の倍数になり、払う人が先に満額払い終わる
   * ・受け取る人が受け取れなかった合計が remainder（割り切れない端数）
   */
  function calcSettlement(paid, weights, unit) {
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const total = paid.reduce((a, b) => a + b, 0);

    const burdens = weights.map(w => Math.floor(total * w / (totalWeight * unit)) * unit);

    const debtors = [];   // 払う人
    const creditors = []; // 受け取る人
    let creditTotal = 0;  // 受け取る人の収支の合計
    paid.forEach((p, i) => {
      const balance = p - burdens[i]; // 収支 = 立て替えた額 − 負担額
      if (balance < 0) {
        const pay = Math.floor(-balance / unit) * unit;
        if (pay > 0) debtors.push({ index: i, value: pay });
      }
      if (balance > 0) {
        creditors.push({ index: i, value: Math.ceil(balance / unit) * unit });
        creditTotal += balance;
      }
    });
    debtors.sort((a, b) => b.value - a.value);
    creditors.sort((a, b) => b.value - a.value);

    // 金額の大きい人から順に組み合わせる（送金は人数−1回以内）
    const transfers = [];
    let sent = 0;
    let d = 0;
    let c = 0;
    while (d < debtors.length && c < creditors.length) {
      const amount = Math.min(debtors[d].value, creditors[c].value);
      transfers.push({ from: debtors[d].index, to: creditors[c].index, amount });
      sent += amount;
      debtors[d].value -= amount;
      creditors[c].value -= amount;
      if (debtors[d].value === 0) d++;
      if (creditors[c].value === 0) c++;
    }
    return { totalWeight, total, burdens, remainder: creditTotal - sent, transfers };
  }

    /* ========== 清算ロジック（払わない人を選んで計算用） ==========
   * 各人の負担額が決まっているときに、誰が誰にいくら払うかを決める
   * paid: 各人が立て替えた金額、burdens: 各人の負担額、unit: お金を動かす単位（1 / 10 / 100円）
   * 考え方は calcSettlement と同じ（払う人は負担額ぶんを満額、受け取る人が端数を引き受ける）
   */
  function settleByBurdens(paid, burdens, unit) {
    const debtors = [];   // 払う人
    const creditors = []; // 受け取る人
    let creditTotal = 0;
    paid.forEach((p, i) => {
      const balance = p - burdens[i];
      if (balance < 0) {
        const pay = Math.floor(-balance / unit) * unit;
        if (pay > 0) debtors.push({ index: i, value: pay });
      }
      if (balance > 0) {
        creditors.push({ index: i, value: Math.ceil(balance / unit) * unit });
        creditTotal += balance;
      }
    });
    debtors.sort((a, b) => b.value - a.value);
    creditors.sort((a, b) => b.value - a.value);

    const transfers = [];
    let sent = 0;
    let d = 0;
    let c = 0;
    while (d < debtors.length && c < creditors.length) {
      const amount = Math.min(debtors[d].value, creditors[c].value);
      transfers.push({ from: debtors[d].index, to: creditors[c].index, amount });
      sent += amount;
      debtors[d].value -= amount;
      creditors[c].value -= amount;
      if (debtors[d].value === 0) d++;
      if (creditors[c].value === 0) c++;
    }

    // 実際に出す金額（立替＋支払−受取）が、負担額より多い分
    const extras = paid.map((p, i) => p - burdens[i]);
    transfers.forEach(t => {
      extras[t.from] += t.amount;
      extras[t.to] -= t.amount;
    });
    return { transfers, remainder: creditTotal - sent, extras };
  }

  const gcdBig = (a, b) => {
    while (b) { [a, b] = [b, a % b]; }
    return a;
  };

  // data: 入力の確認でできたまとめ（counts, patternCount を含む）、unit: お金を動かす単位
  // 項目の金額は、その項目を払う人だけで割り、残りの金額は全員で割る。
  // 小数の誤差を避けるため、負担額は分数（BigInt）で正確に計算してから、unit の単位で切り捨てる。
  function calcExclude(data, unit) {
    const { activeItems, payers, paidTotal, itemTotal, totalPeople, counts, patternCount } = data;

    const people = BigInt(totalPeople);
    const base = BigInt(paidTotal - itemTotal); // 項目の金額を除いた、残りの金額
    const payCounts = activeItems.map(it => {
      let c = 0;
      for (let mask = 0; mask < patternCount; mask++) {
        if (!(mask & it.bit)) c += counts.get(mask) || 0;
      }
      return BigInt(c); // その項目を払う人数
    });
    let den = people;
    payCounts.forEach(c => { den = den / gcdBig(den, c) * c; });

    // 組み合わせごとの負担額
    const burdenInfo = new Map();
    for (let mask = 0; mask < patternCount; mask++) {
      if (!((counts.get(mask) || 0) > 0)) continue;
      let num = base * (den / people);
      activeItems.forEach((it, k) => {
        if (!(mask & it.bit)) num += BigInt(it.amount) * (den / payCounts[k]);
      });
      const burden = Number(num / (den * BigInt(unit))) * unit;
      burdenInfo.set(mask, { num, den, burden });
    }

        // 1人ずつの一覧（立て替えた人は名前つき、それ以外は「立て替えていない人」）
    const entities = [];
    burdenInfo.forEach((info, mask) => {
      const mine = [];
      payers.forEach((p, i) => { if (p.mask === mask) mine.push(i); });
      mine.forEach(i => entities.push({ kind: 'payer', payer: i, mask, paid: payers[i].amount }));
      for (let k = 0; k < counts.get(mask) - mine.length; k++) {
        entities.push({ kind: 'anon', mask, paid: 0, no: k + 1 }); // no: 同じ組み合わせの中での番号
      }
    });

    const settled = settleByBurdens(
      entities.map(e => e.paid),
      entities.map(e => burdenInfo.get(e.mask).burden),
      unit
    );
    return { burdenInfo, entities, ...settled };
  }

  // 分数（num ÷ den）を、小数第3位まで（割り切れないときは「…」付き）の文字にする
  function fractionText(num, den) {
    const frac = (num % den) * 1000n / den;
    let text = Number(num / den).toLocaleString('ja-JP');
    if (frac > 0n) text += '.' + frac.toString().padStart(3, '0').replace(/0+$/, '');
    if ((num * 1000n) % den !== 0n) text += '…';
    return text;
  }

  /* ========== 入力値の読み取り ========== */
  // 全角数字・カンマ・「円」を取り除いて整数にする。空欄は0、読めなければ NaN
  function parseAmount(raw) {
    const s = raw
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[,，\s円]/g, '');
    if (s === '') return 0;
    if (!/^\d{1,9}$/.test(s)) return NaN;
    return Number(s);
  }

  /* ========== 金額欄の式の計算（eval は使わず、数字と記号だけを読み取る） ========== */
  // 全角の数字・記号を半角にそろえ、カンマ・空白・「円」を取り除く
  function normalizeExpr(raw) {
    return raw
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/＋/g, '+')
      .replace(/[−－ー‐–—]/g, '-')
      .replace(/[×＊xX✕]/g, '*')
      .replace(/[÷／]/g, '/')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/．/g, '.')
      .replace(/[,，、\s円]/g, '');
  }

  // 四則演算と括弧だけを計算する。読み取れないときは例外を投げる
  function evaluateExpression(src) {
    let pos = 0;
    const peek = () => src[pos];

    function expr() {
      let v = term();
      while (peek() === '+' || peek() === '-') {
        const op = src[pos++];
        const r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function term() {
      let v = factor();
      while (peek() === '*' || peek() === '/') {
        const op = src[pos++];
        const r = factor();
        v = op === '*' ? v * r : v / r;
      }
      return v;
    }
    function factor() {
      const ch = peek();
      if (ch === '+') { pos++; return factor(); }
      if (ch === '-') { pos++; return -factor(); }
      if (ch === '(') {
        pos++;
        const v = expr();
        if (peek() !== ')') throw new Error('syntax');
        pos++;
        return v;
      }
      const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(pos));
      if (!m) throw new Error('syntax');
      pos += m[0].length;
      return Number(m[0]);
    }

    const v = expr();
    if (pos !== src.length) throw new Error('syntax');
    return v;
  }

  // 金額欄の文字を判定する
  // 戻り値: { status: 'empty' | 'ok' | 'error', value, isExpr, fraction, message }
  function evalAmount(raw) {
    const src = normalizeExpr(raw);
    if (src === '') return { status: 'empty', value: 0 };
    if (src.length > 100 || !/^[0-9.+\-*/()]+$/.test(src)) {
      return { status: 'error', message: '式が読み取れません' };
    }
    let value;
    try {
      value = evaluateExpression(src);
    } catch (err) {
      return { status: 'error', message: '式が読み取れません' };
    }
    if (!Number.isFinite(value)) return { status: 'error', message: '式が読み取れません' };
    if (value < 0) return { status: 'error', message: '金額がマイナスになっています' };
    const rounded = Math.round(value);
    if (rounded > 999999999) return { status: 'error', message: '金額が大きすぎます' };
    return {
      status: 'ok',
      value: rounded,
      isExpr: !/^\d+$/.test(src),
      fraction: Math.abs(value - rounded) > 1e-9
    };
  }

  const yen = n => n.toLocaleString('ja-JP') + '円';

  /* ========== 画面（1つのモードぶんの入力欄と結果欄） ========== */
  function createPanel(root) {
  const $ = role => root.querySelector(`[data-role="${role}"]`);
  const membersEl = $('members');
  const countInput = $('count-input');
  const errorEl = $('error');
  const resultEl = $('result');
  let count = DEFAULT_MEMBERS;
  let unit = 1;          // 送金額の丸め単位（1 / 10 / 100）
  let lastResult = null; // 直前の計算結果（丸めボタンで描画をやり直すために保存）

  function hideResult() {
    resultEl.hidden = true;
    errorEl.hidden = true;
  }

  function createRow(i) {
    const row = document.createElement('div');
    row.className = 'member-row';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'name';
    name.placeholder = 'メンバー' + (i + 1);
    name.autocomplete = 'off';
    name.setAttribute('aria-label', `メンバー${i + 1}の名前`);

    const amount = document.createElement('input');
    amount.type = 'text';
    amount.className = 'amount';
    amount.inputMode = 'numeric';
    amount.autocomplete = 'off';
    amount.placeholder = '立て替えた金額';
    amount.setAttribute('aria-label', `メンバー${i + 1}が立て替えた金額`);

    // 式のときの「＝10,900円」や、読み取れないときのメッセージを出す場所
    const msg = document.createElement('p');
    msg.className = 'amount-msg';

    row.append(name, amount, msg);
    return row;
  }

  // 人数に合わせて行を増減する（すでに入力した行の内容は残す）
  function setCount(n) {
    count = Math.min(MAX_MEMBERS, Math.max(MIN_MEMBERS, n));
    countInput.value = count;
    while (membersEl.children.length < count) {
      membersEl.appendChild(createRow(membersEl.children.length));
    }
    while (membersEl.children.length > count) {
      membersEl.lastElementChild.remove();
    }
    hideResult();
  }

  // 1行ぶんの金額欄を判定して、「＝〇円」やエラーの表示を更新する
  function judgeRow(row) {
    const input = row.querySelector('.amount');
    const msg = row.querySelector('.amount-msg');
    const r = evalAmount(input.value);

    input.classList.toggle('invalid', r.status === 'error');
    msg.classList.toggle('error', r.status === 'error');
    if (r.status === 'error') {
      msg.textContent = r.message;
    } else if (r.status === 'ok' && r.isExpr) {
      msg.textContent = `＝${yen(r.value)}` + (r.fraction ? '（1円未満は四捨五入）' : '');
    } else {
      msg.textContent = '';
    }
    return r;
  }

  function readMembers() {
    return Array.from(membersEl.children).map((row, i) => {
      const r = judgeRow(row);
      return {
        name: row.querySelector('.name').value.trim() || 'メンバー' + (i + 1),
        amount: r.status === 'error' ? NaN : r.value
      };
    });
  }

  function showError(message) {
    resultEl.hidden = true;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  /* ========== 結果の表示 ========== */
  function addSub(li, text) {
    const span = document.createElement('span');
    span.className = 'names';
    span.textContent = text;
    li.appendChild(span);
  }

  // 入力を保存してから描画する（丸めボタンでは入力はそのままで、計算と描画をやり直す）
  function renderResult(members, weights) {
    lastResult = { members, weights };
    drawResult();
  }

  function drawResult() {
    const { members, weights } = lastResult;
    const calc = calcSettlement(members.map(m => m.amount), weights, unit);
    const { totalWeight, total, burdens, remainder, transfers } = calc;
    const list = $('result-list');
    list.innerHTML = '';

    root.querySelectorAll('.round-btn').forEach(b => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.unit) === unit));
    });

    $('result-summary').textContent = `合計 ${yen(total)}（${members.length}人）`;

    if (transfers.length === 0) {
      const li = document.createElement('li');
      li.textContent = '送金はありません。';
      list.appendChild(li);
    }

    // 同じ受取人・同じ金額を払う人はまとめる
    const groups = new Map();
    transfers.forEach(t => {
      const key = `${t.to}:${t.amount}`;
      if (!groups.has(key)) groups.set(key, { to: t.to, amount: t.amount, froms: [] });
      groups.get(key).froms.push(t.from);
    });

    groups.forEach(g => {
      const li = document.createElement('li');
      const to = members[g.to].name;
      const amount = document.createElement('span');
      amount.className = 'amount';
      amount.textContent = yen(g.amount);

      // 払う人の名前を並べて、「〇〇 → △△ へ □円支払う」の形で出す
      const fromNames = g.froms.map(i => members[i].name).join('、');
      li.append(`${fromNames} → ${to} へ `, amount, g.froms.length === 1 ? '支払う' : 'ずつ支払う');
      list.appendChild(li);
    });

    // 計算上の金額と違うとき、負担額より多く出す人がいるときだけ知らせる
    const perPersonEl = $('per-person-note');
    const remainderEl = $('remainder-note');
    const differs = burdens.some((b, i) => b * totalWeight !== total * weights[i]);

    // 実際に出す金額（立替＋支払−受取）が、負担額より多い人を探す
    const extras = members.map((m, i) => m.amount - burdens[i]);
    transfers.forEach(t => {
      extras[t.from] += t.amount;
      extras[t.to] -= t.amount;
    });
    const over = new Map(); // 多く出す金額 → その金額を多く出す人たちの名前
    extras.forEach((x, i) => {
      if (x > 0) {
        if (!over.has(x)) over.set(x, []);
        over.get(x).push(members[i].name);
      }
    });

    perPersonEl.hidden = !differs;
    remainderEl.hidden = over.size === 0;
    if (differs) {
      const exact = total / members.length;
      const exactText = Number(exact.toFixed(3)).toLocaleString('ja-JP', { maximumFractionDigits: 3 })
        + ((total * 1000) % members.length === 0 ? '' : '…');
      perPersonEl.textContent = `1人あたり ${yen(burdens[0])}（計算上は ${exactText}円）で計算しています。`;
    }
    if (over.size > 0) {
      const parts = [...over]
        .sort((p, q) => q[0] - p[0])
        .map(([x, names]) => names.length === 1
          ? `${names[0]}が${yen(x)}`
          : `${names.join('、')}が各${yen(x)}`);
      remainderEl.textContent =
        `${parts.join('、')}多く出す形になっています。次回のお会計などで調整してください。`;
    }
    $('remainder-box').hidden = !differs && over.size === 0;

    // 明細（立替額・負担額・受取／支払）
    const out = members.map(() => 0);
    const received = members.map(() => 0);
    transfers.forEach(t => { out[t.from] += t.amount; received[t.to] += t.amount; });

    const body = $('detail-body');
    body.innerHTML = '';
    members.forEach((m, i) => {
      const flow = received[i] > 0 ? `受取 ${yen(received[i])}`
        : out[i] > 0 ? `支払 ${yen(out[i])}` : '―';
      const tr = document.createElement('tr');
      [m.name, yen(m.amount), yen(burdens[i]), flow].forEach(text => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });

    errorEl.hidden = true;
    resultEl.hidden = false;
  }

  function onCalc() {
    const members = readMembers();

    if (members.some(m => Number.isNaN(m.amount))) {
      showError('式が読み取れない欄があります。赤くなっている欄を確認してください。');
      return;
    }
    const total = members.reduce((sum, m) => sum + m.amount, 0);
    if (total === 0) {
      showError('立て替えた金額が入力されていません。');
      return;
    }

    const weights = members.map(() => 1);
    renderResult(members, weights);
  }

  /* ========== イベント登録 ========== */
  $('count-minus').addEventListener('click', () => setCount(count - 1));
  $('count-plus').addEventListener('click', () => setCount(count + 1));
  countInput.addEventListener('change', () => {
    const n = parseInt(parseAmount(countInput.value), 10);
    setCount(Number.isNaN(n) ? count : n);
  });
  $('calc-btn').addEventListener('click', onCalc);

  // 丸め方のボタン（再計算はせず、表示だけやり直す）
  root.querySelectorAll('.round-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      unit = Number(btn.dataset.unit);
      if (lastResult) drawResult();
    }));

  // 名前や金額を変えたら古い結果を隠す
  membersEl.addEventListener('input', hideResult);

  /* ========== 金額欄の式入力（記号ボタン） ========== */
  // 金額欄を触っている間だけ、その欄のすぐ下に記号ボタンを出す
  const calcBar = document.createElement('div');
  calcBar.className = 'calc-bar';
  calcBar.hidden = true;
  [['＋', '+'], ['－', '-'], ['×', '×'], ['÷', '÷'], ['（', '('], ['）', ')']].forEach(([label, sym]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.tabIndex = -1;
    b.textContent = label;
    b.dataset.sym = sym;
    calcBar.appendChild(b);
  });
  let barInput = null; // 記号を入れる先の金額欄
  let hideTimer = null;

  function insertSymbol(input, sym) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + sym + input.value.slice(end);
    input.setSelectionRange(start + sym.length, start + sym.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  // ボタンを押しても、金額欄から離れたことにならない（キーボードも閉じない）ようにする
  calcBar.addEventListener('mousedown', e => e.preventDefault());
  calcBar.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn && barInput) insertSymbol(barInput, btn.dataset.sym);
  });

  membersEl.addEventListener('focusin', e => {
    if (!e.target.classList.contains('amount')) return;
    clearTimeout(hideTimer);
    barInput = e.target;
    e.target.closest('.member-row').appendChild(calcBar);
    calcBar.hidden = false;
    calcBar.scrollIntoView({ block: 'nearest' });
  });

  membersEl.addEventListener('focusout', e => {
    if (!e.target.classList.contains('amount')) return;
    judgeRow(e.target.closest('.member-row')); // 入力欄から離れたときに判定する
    // すぐに消すと、押そうとしたボタンの位置がずれて押せなくなるので、少し待ってから消す
    hideTimer = setTimeout(() => { calcBar.hidden = true; barInput = null; }, 300);
  });

  // 入力中は何も表示しない（前の判定の表示は消す）
  membersEl.addEventListener('input', e => {
    if (!e.target.classList.contains('amount')) return;
    const row = e.target.closest('.member-row');
    const msg = row.querySelector('.amount-msg');
    e.target.classList.remove('invalid');
    msg.textContent = '';
    msg.classList.remove('error');
    // 式を打っているときは、判定の表示ぶんの場所をあらかじめ空けておく（ボタンの位置がずれないように）
    row.classList.toggle('expr', /[^0-9,，\s円０-９]/.test(e.target.value));
  });

  setCount(DEFAULT_MEMBERS);
  }

    /* ========== 払わない人を選んで計算（項目・人数・立て替えの3つの入力欄） ========== */
  function createExcludePanel(root) {
    const MAX_ITEMS = 4;        // 払わない人がいる項目の最大数
    const MAX_PAYERS = 4;       // 立て替えた人の最大人数
    const DEFAULT_PAYERS = 3;   // 最初に表示する、立て替えた人の欄の数
    const MAX_COUNT = 99;       // 人数の1つの欄の上限

    const $ = role => root.querySelector(`[data-role="${role}"]`);
    const itemsEl = $('items');
    const patternsEl = $('patterns');
    const payersEl = $('payers');
    const addItemBtn = $('add-item');
    const addPayerBtn = $('add-payer');
    const errorEl = $('error');
    const resultEl = $('result');

    // 「どの項目を払わないか」を、項目ごとのビットで表す（項目1=1、項目2=2、項目3=4、項目4=8）
    // counts: その組み合わせの人数
    const counts = new Map();
    let unit = 1;          // 送金額の丸め単位（1 / 10 / 100）
    let lastData = null;   // 直前の入力のまとめ（丸めボタンで計算をやり直すために保存）

    const itemRows = () => Array.from(itemsEl.children);
    const payerRows = () => Array.from(payersEl.children);
    const itemName = (row, i) => row.querySelector('.item-name').value.trim() || `項目${i + 1}`;
    const itemNames = () => itemRows().map((row, i) => itemName(row, i));

    function maskLabel(mask, names) {
      const out = names.filter((_, i) => mask & (1 << i));
      return out.length === 0 ? 'すべて払う人' : `${out.join('・')}を払わない人`;
    }
    // 項目 d を取り除いたときの、ビットの詰め直し
    function dropBit(mask, d) {
      const low = mask & ((1 << d) - 1);
      const high = mask >> (d + 1);
      return low | (high << d);
    }

    function hideResult() {
      resultEl.hidden = true;
      errorEl.hidden = true;
    }
    function showError(message) {
      resultEl.hidden = true;
      errorEl.textContent = message;
      errorEl.hidden = false;
    }

    // 1行ぶんの金額欄を判定して、「＝〇円」やエラーの表示を更新する
    function judgeRow(row) {
      const input = row.querySelector('.amount');
      const msg = row.querySelector('.amount-msg');
      const r = evalAmount(input.value);

      input.classList.toggle('invalid', r.status === 'error');
      msg.classList.toggle('error', r.status === 'error');
      if (r.status === 'error') {
        msg.textContent = r.message;
      } else if (r.status === 'ok' && r.isExpr) {
        msg.textContent = `＝${yen(r.value)}` + (r.fraction ? '（1円未満は四捨五入）' : '');
      } else {
        msg.textContent = '';
      }
      return r;
    }

    /* ----- 1：払わない人がいる項目 ----- */
    function createItemRow() {
      const row = document.createElement('div');
      row.className = 'ex-row item';

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'item-name';
      name.autocomplete = 'off';

      const amount = document.createElement('input');
      amount.type = 'text';
      amount.className = 'amount';
      amount.inputMode = 'numeric';
      amount.autocomplete = 'off';
      amount.placeholder = '金額';

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del-btn';
      del.textContent = '削除';

      // 式のときの「＝10,900円」や、読み取れないときのメッセージを出す場所
      const msg = document.createElement('p');
      msg.className = 'amount-msg';

      row.append(name, amount, del, msg);
      return row;
    }

    // 項目の増減・名前の変更のあとに、人数の欄と立て替えた人のチェックを作り直す
    function refreshItems() {
      const rows = itemRows();
      rows.forEach((row, i) => {
        row.querySelector('.item-name').placeholder = `例）アルコール代`;
        row.querySelector('.item-name').setAttribute('aria-label', `項目${i + 1}の名前`);
        row.querySelector('.amount').setAttribute('aria-label', `項目${i + 1}の金額`);
      });
      addItemBtn.hidden = rows.length >= MAX_ITEMS;
      buildPatterns();
      payerRows().forEach(renderChecks);
    }

    function addItem() {
      if (itemRows().length >= MAX_ITEMS) return;
      itemsEl.appendChild(createItemRow());
      refreshItems();
      hideResult();
    }

    function removeItem(row) {
      const rows = itemRows();
      if (rows.length === 1) {
        // 最後の1つは消さずに、中身を空にする
        row.querySelector('.item-name').value = '';
        row.querySelector('.amount').value = '';
        row.querySelector('.amount').classList.remove('invalid');
        row.querySelector('.amount-msg').textContent = '';
      } else {
        const d = rows.indexOf(row);
        row.remove();
        // 人数と、立て替えた人のチェックを、項目が減ったあとの形に直す
        const old = Array.from(counts);
        counts.clear();
        old.forEach(([mask, n]) => {
          const m = dropBit(mask, d);
          counts.set(m, (counts.get(m) || 0) + n);
        });
        payerRows().forEach(p => { p._mask = dropBit(p._mask, d); });
      }
      refreshItems();
      hideResult();
    }

    /* ----- 2：人数 ----- */
    function buildPatterns() {
      const names = itemNames();
      patternsEl.innerHTML = '';
      for (let mask = 0; mask < (1 << names.length); mask++) {
        const row = document.createElement('div');
        row.className = 'pattern-row';

        const label = document.createElement('span');
        label.className = 'pattern-label';
        label.textContent = maskLabel(mask, names);

        const stepper = document.createElement('div');
        stepper.className = 'stepper';

        const minus = document.createElement('button');
        minus.type = 'button';
        minus.textContent = '−';
        minus.setAttribute('aria-label', `${label.textContent}の人数を減らす`);

        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.autocomplete = 'off';
        input.setAttribute('aria-label', `${label.textContent}の人数`);
        input.value = counts.get(mask) || 0;

        const plus = document.createElement('button');
        plus.type = 'button';
        plus.textContent = '＋';
        plus.setAttribute('aria-label', `${label.textContent}の人数を増やす`);

        const setValue = v => {
          const n = Math.min(MAX_COUNT, Math.max(0, v));
          counts.set(mask, n);
          input.value = n;
          hideResult();
        };
        minus.addEventListener('click', () => setValue((counts.get(mask) || 0) - 1));
        plus.addEventListener('click', () => setValue((counts.get(mask) || 0) + 1));
        input.addEventListener('change', () => {
          const n = parseAmount(input.value);
          setValue(Number.isNaN(n) ? (counts.get(mask) || 0) : n);
        });

        stepper.append(minus, input, plus);
        row.append(label, stepper);
        patternsEl.appendChild(row);
      }
    }

    /* ----- セクション3：立て替えた人 ----- */
    function createPayerRow() {
      const row = document.createElement('div');
      row.className = 'ex-row payer';
      row._mask = 0; // この人が払わない項目（ビット）

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'payer-name';
      name.autocomplete = 'off';

      const amount = document.createElement('input');
      amount.type = 'text';
      amount.className = 'amount';
      amount.inputMode = 'numeric';
      amount.autocomplete = 'off';
      amount.placeholder = '立て替えた金額';

      const msg = document.createElement('p');
      msg.className = 'amount-msg';

      const checks = document.createElement('div');
      checks.className = 'ex-checks';

      row.append(name, amount, msg, checks);
      return row;
    }

    // この人が払わない項目のチェックを、項目の数だけ作る
    function renderChecks(row) {
      const checks = row.querySelector('.ex-checks');
      checks.innerHTML = '';

      const lead = document.createElement('span');
      lead.className = 'ex-checks-lead';
      lead.textContent = '払わない項目：';
      checks.appendChild(lead);

      itemNames().forEach((nm, i) => {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = Boolean(row._mask & (1 << i));
        cb.addEventListener('change', () => {
          row._mask = cb.checked ? (row._mask | (1 << i)) : (row._mask & ~(1 << i));
          hideResult();
        });
        const text = document.createElement('span');
        text.textContent = nm;
        label.append(cb, text);
        checks.appendChild(label);
      });
    }

    function refreshPayers() {
      const rows = payerRows();
      rows.forEach((row, i) => {
        row.querySelector('.payer-name').placeholder = `立て替えた人${i + 1}`;
        row.querySelector('.payer-name').setAttribute('aria-label', `立て替えた人${i + 1}の名前`);
        row.querySelector('.amount').setAttribute('aria-label', `立て替えた人${i + 1}が立て替えた金額`);
      });
      addPayerBtn.hidden = rows.length >= MAX_PAYERS;
    }

    function addPayer() {
      if (payerRows().length >= MAX_PAYERS) return;
      const row = createPayerRow();
      payersEl.appendChild(row);
      renderChecks(row);
      refreshPayers();
      hideResult();
    }

    /* ----- 入力の確認（バリデーション） ----- */
    // 戻り値: { error: '文言' } か、確認できた入力のまとめ
    function collect() {
      let hasError = false;

      const items = itemRows().map((row, i) => {
        const r = judgeRow(row);
        if (r.status === 'error') hasError = true;
        return { bit: 1 << i, name: itemName(row, i), amount: r.status === 'ok' ? r.value : 0 };
      });
      const payers = payerRows().map((row, i) => {
        const r = judgeRow(row);
        if (r.status === 'error') hasError = true;
        return {
          name: row.querySelector('.payer-name').value.trim() || `立て替えた人${i + 1}`,
          amount: r.status === 'ok' ? r.value : 0,
          mask: row._mask
        };
      }).filter(p => p.amount > 0); // 金額が空欄の行は、使わない

      if (hasError) return { error: '式が読み取れない欄があります。赤くなっている欄を確認してください。' };

      const activeItems = items.filter(it => it.amount > 0); // 金額が空欄の項目は、計算に含めない
      if (activeItems.length === 0) return { error: '払わない人がいる項目の金額を入力してください。' };
      if (payers.length === 0) return { error: '立て替えた金額を入力してください。' };

      const names = items.map(it => it.name);
      const patternCount = 1 << items.length;
      let totalPeople = 0;
      for (let mask = 0; mask < patternCount; mask++) totalPeople += counts.get(mask) || 0;
      if (totalPeople === 0) return { error: '人数を入力してください。' };

      const itemTotal = activeItems.reduce((sum, it) => sum + it.amount, 0);
      const paidTotal = payers.reduce((sum, p) => sum + p.amount, 0);
      if (itemTotal > paidTotal) {
        return { error: `払わない人がいる項目の金額のほうが、立て替えた金額よりも高額です。` };
      }

      // 立て替えた人も人数に含まれるので、組み合わせごとの人数が足りているか確認する
      for (let mask = 0; mask < patternCount; mask++) {
        const need = payers.filter(p => p.mask === mask).length;
        if ((counts.get(mask) || 0) < need) {
          return { error: `「${maskLabel(mask, names)}」の人数が、立て替えた人（${need}人）より少なくなっています。人数には、立て替えた人も含めてください。` };
        }
      }

      // 全員が払わない項目がないか確認する
      for (const it of activeItems) {
        let payCount = 0;
        for (let mask = 0; mask < patternCount; mask++) {
          if (!(mask & it.bit)) payCount += counts.get(mask) || 0;
        }
        if (payCount === 0) {
          return { error: `「${it.name}」を払う人がいません。人数の欄を確認してください。` };
        }
      }

      return { items, activeItems, payers, names, itemTotal, paidTotal, totalPeople };
    }

        function onCalc() {
      const data = collect();
      if (data.error) {
        showError(data.error);
        return;
      }
      data.counts = new Map(counts);            // 結果を出したときの人数を覚えておく
      data.patternCount = 1 << data.items.length;
      lastData = data;
      drawResult();
    }

    function drawResult() {
      const data = lastData;
      const { burdenInfo, entities, transfers, extras } = calcExclude(data, unit);
      const names = data.names;
      const payerName = i => data.payers[i].name;

      root.querySelectorAll('.round-btn').forEach(b => {
        b.setAttribute('aria-pressed', String(Number(b.dataset.unit) === unit));
      });

      $('result-summary').textContent =
        `立て替えた合計 ${yen(data.paidTotal)}（うち項目 ${yen(data.itemTotal)}）、参加 ${data.totalPeople}人`;

      // 1人あたりの負担額（払わない項目の組み合わせごと）
      const burdenList = $('burden-list');
      burdenList.innerHTML = '';
      burdenInfo.forEach((info, mask) => {
        let text = `${maskLabel(mask, names)}（${data.counts.get(mask)}人）：${yen(info.burden)}`;
        if (info.num !== BigInt(info.burden) * info.den) {
          text += `（計算上は ${fractionText(info.num, info.den)}円）`;
        }
        const li = document.createElement('li');
        li.textContent = text;
        burdenList.appendChild(li);
      });

      // 誰が誰にいくら払うか（立て替えていない人は、組み合わせごとにまとめる）
      const list = $('result-list');
      list.innerHTML = '';
      if (transfers.length === 0) {
        const li = document.createElement('li');
        li.textContent = '送金はありません。';
        list.appendChild(li);
      }

            // 立て替えていない人は、同じ組み合わせの中で「①②③…」の番号で区別する
      const circled = n => (n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`);
      const anonCount = new Map();
      entities.forEach(e => {
        if (e.kind === 'anon') anonCount.set(e.mask, (anonCount.get(e.mask) || 0) + 1);
      });

      // 1人ごとに、払う相手と金額をまとめる
      const payments = new Map(); // 1人（entities の番号）→ [{ to, amount }]
      transfers.forEach(t => {
        if (!payments.has(t.from)) payments.set(t.from, []);
        payments.get(t.from).push({ to: entities[t.to].payer, amount: t.amount });
      });

      // 同じ組み合わせで、払い方がまったく同じ人は、1行にまとめる
      const lines = new Map();
      payments.forEach((pays, idx) => {
        const e = entities[idx];
        pays.sort((p, q) => p.to - q.to || p.amount - q.amount);
        const key = e.kind === 'payer'
          ? `p${e.payer}`
          : `a${e.mask}|${pays.map(p => `${p.to}:${p.amount}`).join(',')}`;
        if (!lines.has(key)) lines.set(key, { e, pays, nos: [] });
        if (e.kind === 'anon') lines.get(key).nos.push(e.no);
      });

      lines.forEach(({ e, pays, nos }) => {
        const who = e.kind === 'payer'
          ? payerName(e.payer)
          : `${maskLabel(e.mask, names)}${anonCount.get(e.mask) > 1 ? nos.map(circled).join('') : ''}（立て替えていない人）`;
        const nodes = [`${who} → `];
        pays.forEach((p, i) => {
          if (i > 0) nodes.push('、');
          const amount = document.createElement('span');
          amount.className = 'amount';
          amount.textContent = yen(p.amount);
          nodes.push(`${payerName(p.to)} へ `, amount);
        });
        nodes.push(nos.length > 1 ? 'ずつ支払う' : '支払う');
        const li = document.createElement('li');
        li.append(...nodes);
        list.appendChild(li);
      });

      // 負担額より多く出す人がいるときだけ知らせる
      const over = new Map();
      extras.forEach((x, i) => {
        if (x > 0 && entities[i].kind === 'payer') {
          if (!over.has(x)) over.set(x, []);
          over.get(x).push(payerName(entities[i].payer));
        }
      });
      const noteEl = $('remainder-note');
      noteEl.hidden = over.size === 0;
      if (over.size > 0) {
        const parts = [...over]
          .sort((p, q) => q[0] - p[0])
          .map(([x, ns]) => ns.length === 1 ? `${ns[0]}が${yen(x)}` : `${ns.join('、')}が各${yen(x)}`);
        noteEl.textContent = `${parts.join('、')}多く出す形になっています。次回のお会計などで調整してください。`;
      }

      // 明細（立て替えた人の、立替額・負担額・受取／支払）
      const out = entities.map(() => 0);
      const received = entities.map(() => 0);
      transfers.forEach(t => { out[t.from] += t.amount; received[t.to] += t.amount; });
      const body = $('detail-body');
      body.innerHTML = '';
      entities
        .map((e, i) => ({ e, i }))
        .filter(x => x.e.kind === 'payer')
        .sort((a, b) => a.e.payer - b.e.payer)
        .forEach(({ e, i }) => {
          const flow = received[i] > 0 ? `受取 ${yen(received[i])}`
            : out[i] > 0 ? `支払 ${yen(out[i])}` : '―';
          const tr = document.createElement('tr');
          [payerName(e.payer), yen(e.paid), yen(burdenInfo.get(e.mask).burden), flow].forEach(text => {
            const td = document.createElement('td');
            td.textContent = text;
            tr.appendChild(td);
          });
          body.appendChild(tr);
        });

      errorEl.hidden = true;
      resultEl.hidden = false;
    }

    /* ----- 金額欄の式入力（記号ボタン） ----- */
    const calcBar = document.createElement('div');
    calcBar.className = 'calc-bar';
    calcBar.hidden = true;
    [['＋', '+'], ['－', '-'], ['×', '×'], ['÷', '÷'], ['（', '('], ['）', ')']].forEach(([label, sym]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.textContent = label;
      b.dataset.sym = sym;
      calcBar.appendChild(b);
    });
    let barInput = null;
    let hideTimer = null;

    function insertSymbol(input, sym) {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = input.value.slice(0, start) + sym + input.value.slice(end);
      input.setSelectionRange(start + sym.length, start + sym.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }

    calcBar.addEventListener('mousedown', e => e.preventDefault());
    calcBar.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (btn && barInput) insertSymbol(barInput, btn.dataset.sym);
    });

    /* ----- イベント登録 ----- */
    root.addEventListener('focusin', e => {
      if (!e.target.classList.contains('amount')) return;
      clearTimeout(hideTimer);
      barInput = e.target;
      // 触っている金額欄の、メッセージ欄のすぐ下に出す
      e.target.closest('.ex-row').querySelector('.amount-msg').after(calcBar);
      calcBar.hidden = false;
      calcBar.scrollIntoView({ block: 'nearest' });
    });

    root.addEventListener('focusout', e => {
      if (!e.target.classList.contains('amount')) return;
      judgeRow(e.target.closest('.ex-row')); // 入力欄から離れたときに判定する
      hideTimer = setTimeout(() => { calcBar.hidden = true; barInput = null; }, 300);
    });

    root.addEventListener('input', e => {
      const t = e.target;
      if (t.classList.contains('amount')) {
        // 入力中は何も表示しない（前の判定の表示は消す）
        const row = t.closest('.ex-row');
        const msg = row.querySelector('.amount-msg');
        t.classList.remove('invalid');
        msg.textContent = '';
        msg.classList.remove('error');
        row.classList.toggle('expr', /[^0-9,，\s円０-９]/.test(t.value));
      }
      if (t.classList.contains('item-name')) {
        // 項目名を変えたら、人数の欄と立て替えた人のチェックの名前も変える
        buildPatterns();
        payerRows().forEach(renderChecks);
      }
      hideResult();
    });

    itemsEl.addEventListener('click', e => {
      if (e.target.classList.contains('del-btn')) removeItem(e.target.closest('.ex-row'));
    });
    addItemBtn.addEventListener('click', addItem);
    addPayerBtn.addEventListener('click', addPayer);
    $('calc-btn').addEventListener('click', onCalc);

    
    // 丸め方のボタン（入力はそのままで、計算と表示だけやり直す）
    root.querySelectorAll('.round-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        unit = Number(btn.dataset.unit);
        if (lastData) drawResult();
      }));

    /* ----- 最初の表示 ----- */
    for (let i = 0; i < DEFAULT_PAYERS; i++) payersEl.appendChild(createPayerRow());
    itemsEl.appendChild(createItemRow());
    refreshItems();
    refreshPayers();
  }

    /* ========== 世帯ごとに計算 ========== */
  function createHouseholdPanel(root) {
    const MAX_HOUSEHOLDS = 10;   // 世帯の最大数
    const MAX_PEOPLE = 20;       // 大人・子どもそれぞれの人数の上限
    const DEFAULT_HOUSEHOLDS = 2;
    const DEFAULT_RATIO = 50;    // 子どもの負担割合の初期値（%）

    const $ = role => root.querySelector(`[data-role="${role}"]`);
    const householdsEl = $('households');
    const addBtn = $('add-household');
    const errorEl = $('error');
    const resultEl = $('result');
    let ratio = DEFAULT_RATIO;
    let unit = 1;          // 送金額の丸め単位（1 / 10 / 100）
    let lastResult = null; // 直前の入力（丸めボタンで描画をやり直すために保存）

    const rows = () => Array.from(householdsEl.children);
    const letter = i => String.fromCharCode(65 + i); // 0→A, 1→B ...

    function hideResult() {
      resultEl.hidden = true;
      errorEl.hidden = true;
    }
    function showError(message) {
      resultEl.hidden = true;
      errorEl.textContent = message;
      errorEl.hidden = false;
    }

    // 1行ぶんの金額欄を判定して、「＝〇円」やエラーの表示を更新する
    function judgeRow(row) {
      const input = row.querySelector('.amount');
      const msg = row.querySelector('.amount-msg');
      const r = evalAmount(input.value);

      input.classList.toggle('invalid', r.status === 'error');
      msg.classList.toggle('error', r.status === 'error');
      if (r.status === 'error') {
        msg.textContent = r.message;
      } else if (r.status === 'ok' && r.isExpr) {
        msg.textContent = `＝${yen(r.value)}` + (r.fraction ? '（1円未満は四捨五入）' : '');
      } else {
        msg.textContent = '';
      }
      return r;
    }

    /* ----- 子どもの負担割合 ----- */
    function setRatio(n) {
      ratio = n;
      root.querySelectorAll('.ratio-btn').forEach(b => {
        b.setAttribute('aria-pressed', String(Number(b.dataset.ratio) === n));
      });
      hideResult();
    }

    /* ----- 世帯の入力行 ----- */
    // 人数のステッパー。getValue() で現在の人数が取れる
    function createStepper(initial, min) {
      const wrap = document.createElement('div');
      wrap.className = 'stepper';

      const minus = document.createElement('button');
      minus.type = 'button';
      minus.textContent = '−';

      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.autocomplete = 'off';

      const plus = document.createElement('button');
      plus.type = 'button';
      plus.textContent = '＋';

      let value = initial;
      const set = v => {
        value = Math.min(MAX_PEOPLE, Math.max(min, v));
        input.value = value;
        hideResult();
      };
      input.value = value;
      minus.addEventListener('click', () => set(value - 1));
      plus.addEventListener('click', () => set(value + 1));
      input.addEventListener('change', () => {
        const n = parseAmount(input.value);
        set(Number.isNaN(n) ? value : n);
      });

      wrap.append(minus, input, plus);
      wrap.getValue = () => value;
      return wrap;
    }

    function createRow() {
      const row = document.createElement('div');
      row.className = 'hh-row';

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'hh-name';
      name.autocomplete = 'off';

      const amount = document.createElement('input');
      amount.type = 'text';
      amount.className = 'amount';
      amount.inputMode = 'numeric';
      amount.autocomplete = 'off';
      amount.placeholder = '立て替えた金額';

      // 式のときの「＝10,900円」や、読み取れないときのメッセージを出す場所
      const msg = document.createElement('p');
      msg.className = 'amount-msg';

      const counts = document.createElement('div');
      counts.className = 'hh-counts';
      row._adults = createStepper(2, 0);
      row._children = createStepper(0, 0);
      [['大人', row._adults], ['子ども', row._children]].forEach(([text, stepper]) => {
        const group = document.createElement('div');
        group.className = 'hh-count';
        const label = document.createElement('span');
        label.textContent = text;
        group.append(label, stepper);
        counts.appendChild(group);
      });

      row.append(name, amount, msg, counts);
      return row;
    }

    // 行の増減のあとに、仮の名前（世帯A・世帯B…）と読み上げ用の名前を付け直す
    function refreshRows() {
      rows().forEach((row, i) => {
        const nm = `世帯${letter(i)}`;
        const nameInput = row.querySelector('.hh-name');
        nameInput.placeholder = nm;
        nameInput.setAttribute('aria-label', `${nm}の名前`);
        row.querySelector('.amount').setAttribute('aria-label', `${nm}が立て替えた金額`);
        row._adults.querySelector('input').setAttribute('aria-label', `${nm}の大人の人数`);
        row._children.querySelector('input').setAttribute('aria-label', `${nm}の子どもの人数`);
      });
      addBtn.hidden = rows().length >= MAX_HOUSEHOLDS;
    }

    function addHousehold() {
      if (rows().length >= MAX_HOUSEHOLDS) return;
      householdsEl.appendChild(createRow());
      refreshRows();
      hideResult();
    }

    /* ----- 入力の読み取りと計算 ----- */
    function readHouseholds() {
      return rows().map((row, i) => {
        const r = judgeRow(row);
        const adults = row._adults.getValue();
        const children = row._children.getValue();
        return {
          name: row.querySelector('.hh-name').value.trim() || `世帯${letter(i)}`,
          amount: r.status === 'error' ? NaN : r.value,
          // 口数を100倍の整数にする（大人＝100、子ども＝負担割合の%）
          weight: adults * 100 + children * ratio
        };
      });
    }

    function onCalc() {
      const all = readHouseholds();

      if (all.some(h => Number.isNaN(h.amount))) {
        showError('式が読み取れない欄があります。赤くなっている欄を確認してください。');
        return;
      }
      const idle = all.find(h => h.weight === 0 && h.amount > 0);
      if (idle) {
        showError(`「${idle.name}」は人数が0ですが、立て替えた金額が入っています。人数を確認してください。`);
        return;
      }
      // 人数が0の世帯は、計算に含めない
      const members = all.filter(h => h.weight > 0);
      if (members.length < 2) {
        showError('人数が入っている世帯を、2つ以上にしてください。');
        return;
      }
      if (members.reduce((sum, h) => sum + h.amount, 0) === 0) {
        showError('立て替えた金額が入力されていません。');
        return;
      }

      lastResult = { members };
      drawResult();
    }

    /* ----- 結果の表示 ----- */
    function drawResult() {
      const { members } = lastResult;
      const weights = members.map(h => h.weight);
      const { totalWeight, total, burdens, transfers } =
        calcSettlement(members.map(h => h.amount), weights, unit);

      root.querySelectorAll('.round-btn').forEach(b => {
        b.setAttribute('aria-pressed', String(Number(b.dataset.unit) === unit));
      });

      $('result-summary').textContent =
        `合計 ${yen(total)}（${members.length}世帯・${(totalWeight / 100).toLocaleString('ja-JP')}口）`;

      const list = $('result-list');
      list.innerHTML = '';
      if (transfers.length === 0) {
        const li = document.createElement('li');
        li.textContent = '送金はありません。';
        list.appendChild(li);
      }

      // 同じ受取先・同じ金額の世帯はまとめる
      const groups = new Map();
      transfers.forEach(t => {
        const key = `${t.to}:${t.amount}`;
        if (!groups.has(key)) groups.set(key, { to: t.to, amount: t.amount, froms: [] });
        groups.get(key).froms.push(t.from);
      });
      groups.forEach(g => {
        const amount = document.createElement('span');
        amount.className = 'amount';
        amount.textContent = yen(g.amount);
        const fromNames = g.froms.map(i => members[i].name).join('、');
        const li = document.createElement('li');
        li.append(`${fromNames} → ${members[g.to].name} へ `, amount, g.froms.length === 1 ? '支払う' : 'ずつ支払う');
        list.appendChild(li);
      });

      // 実際に出す金額（立替＋支払−受取）が、負担額より多い世帯を知らせる
      const extras = members.map((h, i) => h.amount - burdens[i]);
      transfers.forEach(t => {
        extras[t.from] += t.amount;
        extras[t.to] -= t.amount;
      });
      const over = new Map();
      extras.forEach((x, i) => {
        if (x > 0) {
          if (!over.has(x)) over.set(x, []);
          over.get(x).push(members[i].name);
        }
      });
      const noteEl = $('remainder-note');
      noteEl.hidden = over.size === 0;
      if (over.size > 0) {
        const parts = [...over]
          .sort((p, q) => q[0] - p[0])
          .map(([x, ns]) => ns.length === 1 ? `${ns[0]}が${yen(x)}` : `${ns.join('、')}が各${yen(x)}`);
        noteEl.textContent = `${parts.join('、')}多く出す形になっています。次回のお会計などで調整してください。`;
      }

      // 明細（口数・立替額・負担額・受取／支払）
      const out = members.map(() => 0);
      const received = members.map(() => 0);
      transfers.forEach(t => { out[t.from] += t.amount; received[t.to] += t.amount; });
      const body = $('detail-body');
      body.innerHTML = '';
      members.forEach((h, i) => {
        const flow = received[i] > 0 ? `受取 ${yen(received[i])}`
          : out[i] > 0 ? `支払 ${yen(out[i])}` : '―';
        const tr = document.createElement('tr');
        [h.name, `${h.weight / 100}口`, yen(h.amount), yen(burdens[i]), flow].forEach(text => {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });

      errorEl.hidden = true;
      resultEl.hidden = false;
    }

    /* ----- 金額欄の式入力（記号ボタン） ----- */
    const calcBar = document.createElement('div');
    calcBar.className = 'calc-bar';
    calcBar.hidden = true;
    [['＋', '+'], ['－', '-'], ['×', '×'], ['÷', '÷'], ['（', '('], ['）', ')']].forEach(([label, sym]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.textContent = label;
      b.dataset.sym = sym;
      calcBar.appendChild(b);
    });
    let barInput = null;
    let hideTimer = null;

    function insertSymbol(input, sym) {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = input.value.slice(0, start) + sym + input.value.slice(end);
      input.setSelectionRange(start + sym.length, start + sym.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }

    calcBar.addEventListener('mousedown', e => e.preventDefault());
    calcBar.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (btn && barInput) insertSymbol(barInput, btn.dataset.sym);
    });

    /* ----- イベント登録 ----- */
    root.addEventListener('focusin', e => {
      if (!e.target.classList.contains('amount')) return;
      clearTimeout(hideTimer);
      barInput = e.target;
      e.target.closest('.hh-row').querySelector('.amount-msg').after(calcBar);
      calcBar.hidden = false;
      calcBar.scrollIntoView({ block: 'nearest' });
    });

    root.addEventListener('focusout', e => {
      if (!e.target.classList.contains('amount')) return;
      judgeRow(e.target.closest('.hh-row')); // 入力欄から離れたときに判定する
      hideTimer = setTimeout(() => { calcBar.hidden = true; barInput = null; }, 300);
    });

    root.addEventListener('input', e => {
      const t = e.target;
      if (t.classList.contains('amount')) {
        // 入力中は何も表示しない（前の判定の表示は消す）
        const row = t.closest('.hh-row');
        const msg = row.querySelector('.amount-msg');
        t.classList.remove('invalid');
        msg.textContent = '';
        msg.classList.remove('error');
        row.classList.toggle('expr', /[^0-9,，\s円０-９]/.test(t.value));
      }
      hideResult();
    });

    root.querySelectorAll('.ratio-btn').forEach(btn =>
      btn.addEventListener('click', () => setRatio(Number(btn.dataset.ratio))));
    addBtn.addEventListener('click', addHousehold);
    $('calc-btn').addEventListener('click', onCalc);

    // 丸め方のボタン（入力はそのままで、計算と表示だけやり直す）
    root.querySelectorAll('.round-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        unit = Number(btn.dataset.unit);
        if (lastResult) drawResult();
      }));

    /* ----- 最初の表示 ----- */
    for (let i = 0; i < DEFAULT_HOUSEHOLDS; i++) householdsEl.appendChild(createRow());
    refreshRows();
    setRatio(DEFAULT_RATIO);
  }

    /* ========== 結果の共有（画面に出ている結果を、文章にして送る） ========== */
  function setupShare(root, modeName) {
    const btn = root.querySelector('[data-role="share-btn"]');
    const msg = root.querySelector('[data-role="share-msg"]');
    const text = el => el.textContent.trim();
    let timer = null;

    // 共有する文章を作る
    function buildText() {
      const lines = [`【割り勘の結果】${modeName}`];
      lines.push(text(root.querySelector('[data-role="result-summary"]')));

      // 1人あたりの負担額（払わない人を選んで計算のときだけある）
      const burdens = root.querySelectorAll('[data-role="burden-list"] li');
      if (burdens.length > 0) {
        lines.push('', '■負担額');
        burdens.forEach(li => lines.push(text(li)));
      }

      lines.push('', '■清算');
      // 清算の見出しのすぐ下にある説明文（①②の説明など）があれば、そのまま入れる
      const listEl = root.querySelector('[data-role="result-list"]');
      const lead = listEl.previousElementSibling;
      if (lead && lead.classList.contains('note')) lines.push(text(lead));
      root.querySelectorAll('[data-role="result-list"] li').forEach(li => lines.push(text(li)));

      // 丸めたときは、必ず書く
      const pressed = root.querySelector('.round-btn[aria-pressed="true"]');
      if (pressed && pressed.dataset.unit !== '1') {
        lines.push('', `※送金額は${text(pressed)}に丸めています。`);
      }
      // 端数についての注意書き（画面に出ているものだけ）
      root.querySelectorAll('[data-role="per-person-note"], [data-role="remainder-note"]').forEach(el => {
        if (!el.closest('[hidden]') && text(el) !== '') lines.push(`※${text(el)}`);
      });

      // 明細
      const heads = Array.from(root.querySelectorAll('.detail thead th')).map(th => text(th));
      lines.push('', '■明細');
      root.querySelectorAll('[data-role="detail-body"] tr').forEach(tr => {
        const cells = Array.from(tr.children).map(td => text(td));
        const rest = cells.slice(1).map((c, i) => `${heads[i + 1]} ${c}`);
        lines.push(`${cells[0]}：${rest.join(' ／ ')}`);
      });
      return lines.join('\n');
    }

    function notify(message) {
      msg.textContent = message;
      msg.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => { msg.hidden = true; }, 3000);
    }

    async function share() {
      const body = buildText();
      try {
        if (navigator.share) {
          await navigator.share({ text: body });
          return;
        }
      } catch (err) {
        if (err.name === 'AbortError') return; // 共有をやめたときは何も出さない
      }
      // 共有機能が使えないときは、コピーする
      try {
        await navigator.clipboard.writeText(body);
        notify('コピーしました。LINEなどに貼り付けてください。');
      } catch (err) {
        notify('コピーできませんでした。');
      }
    }

    btn.addEventListener('click', share);
  }

  /* ========== モード切り替え ========== */
  function onModeChange() {
    const modeNode = document.querySelector('input[name="mode"]:checked');
    if (!modeNode) return;
    const mode = modeNode.value;
    document.getElementById('mode-desc').textContent = DESCRIPTIONS[mode] || '';
    document.getElementById('panel-equal').hidden = mode !== 'equal';
    document.getElementById('panel-exclude').hidden = mode !== 'exclude';
        document.getElementById('panel-household').hidden = mode !== 'household';
  }

  document.querySelectorAll('input[name="mode"]').forEach(r =>
    r.addEventListener('change', onModeChange));

  /* ========== 起動 ========== */
  createPanel(document.getElementById('panel-equal'));
  createExcludePanel(document.getElementById('panel-exclude'));
  createHouseholdPanel(document.getElementById('panel-household'));
  setupShare(document.getElementById('panel-equal'), '全員平等に計算');
  setupShare(document.getElementById('panel-exclude'), '払わない人を選んで計算');
  setupShare(document.getElementById('panel-household'), '世帯ごとに計算');
  onModeChange();
})();