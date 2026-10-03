const DEFAULTS = Object.freeze({ variant: 'current', row: 0, side: 1 });
const VARIANTS = [
  { value: 'current', label: '現状' },
  { value: 'spread', label: '中心から広がる' },
  { value: 'rimfall', label: '縁へ降る' },
  { value: 'pulse', label: 'ゆっくり明滅' }
];
const ROWS = ['ピンク', 'オレンジ', '黄色', 'ミント'];

function createPanel(api) {
  if (document.querySelector('.compare-panel')) return;

  const state = { ...DEFAULTS };
  const panel = document.createElement('section');
  panel.className = 'compare-panel';
  panel.setAttribute('aria-labelledby', 'compare-title');
  panel.innerHTML = `
    <div class="compare-panel__heading">
      <h2 id="compare-title">ひかりの見え方をくらべる</h2>
      <p>色はすべて同じ白。明滅は約2秒周期です。4色で見つけやすさを比べてください。</p>
    </div>
    <div class="compare-panel__controls">
      <fieldset class="compare-panel__group compare-panel__variants">
        <legend>ひかり</legend>
        <div class="compare-panel__variant-list">
          ${VARIANTS.map(({ value, label }) => `<button type="button" data-compare-variant="${value}" aria-pressed="false">${label}</button>`).join('')}
        </div>
      </fieldset>
      <label class="compare-panel__select compare-panel__group">色
        <select id="compare-row" aria-label="色">
          ${ROWS.map((label, index) => `<option value="${index}">${label}</option>`).join('')}
        </select>
      </label>
      <label class="compare-panel__select compare-panel__group compare-panel__side">向き
        <select id="compare-side" aria-label="向き">
          <option value="1">おもて</option>
          <option value="-1">うら</option>
        </select>
      </label>
      <button type="button" class="compare-panel__replay"><span class="compare-panel__replay-long">もう一度点灯</span><span class="compare-panel__replay-short">再点灯</span></button>
    </div>
  `;

  const playArea = document.querySelector('.app > .play-area');
  if (!playArea || !playArea.parentElement) return;
  playArea.parentElement.insertBefore(panel, playArea);

  const update = () => {
    panel.querySelectorAll('[aria-pressed]').forEach((button) => {
      const active = button.dataset.compareVariant === state.variant
        ;
      button.setAttribute('aria-pressed', String(active));
    });
    panel.querySelector('#compare-row').value = String(state.row);
    panel.querySelector('#compare-side').value = String(state.side);
  };

  const apply = () => {
    api.set({ variant: state.variant, row: state.row, side: state.side });
    update();
  };

  panel.addEventListener('change', (event) => {
    if (event.target.id === 'compare-row') state.row = Number(event.target.value);
    if (event.target.id === 'compare-side') state.side = Number(event.target.value);
    apply();
  });

  panel.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || !panel.contains(button)) return;
    if (button.dataset.compareVariant) state.variant = button.dataset.compareVariant;
    if (button.classList.contains('compare-panel__replay')) {
      api.set({ variant: state.variant, row: state.row, side: state.side });
      api.replay();
      update();
      return;
    }
    apply();
  });

  apply();
}

function connect() {
  const api = window.__lightCompare;
  if (api && typeof api.set === 'function' && typeof api.replay === 'function') {
    createPanel(api);
    return true;
  }
  return false;
}

if (!connect()) {
  window.addEventListener('lightcompare-ready', connect, { once: true });
}
