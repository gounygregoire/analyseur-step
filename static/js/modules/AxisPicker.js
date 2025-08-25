export class AxisPicker extends EventTarget {
  constructor(container) {
    super();
    this.el = container;
    this.state = { axis: 'X', direction: 1 };
    this._render();
    this._bind();
  }

  _render() {
    this.el.innerHTML = `
      <div class="btn-group" role="group">
        <input type="radio" class="btn-check" name="axis" id="axisX" value="X" autocomplete="off" checked>
        <label class="btn btn-outline-secondary" for="axisX">X</label>
        <input type="radio" class="btn-check" name="axis" id="axisY" value="Y" autocomplete="off">
        <label class="btn btn-outline-secondary" for="axisY">Y</label>
        <input type="radio" class="btn-check" name="axis" id="axisZ" value="Z" autocomplete="off">
        <label class="btn btn-outline-secondary" for="axisZ">Z</label>
        <input type="radio" class="btn-check" name="axis" id="axisAuto" value="AUTO" autocomplete="off">
        <label class="btn btn-outline-secondary" for="axisAuto">Auto</label>
      </div>
      <div class="form-check form-switch d-inline-block ms-3">
        <input class="form-check-input" type="checkbox" id="axisInvert">
        <label class="form-check-label" for="axisInvert">Inverser le sens</label>
      </div>
      <div class="mt-2">
        <button id="axisPreviewBtn" class="btn btn-sm btn-secondary">Aperçu</button>
        <button id="axisClearBtn" class="btn btn-sm btn-outline-secondary ms-1">Effacer aperçu</button>
        <button id="axisConfirmBtn" class="btn btn-sm btn-primary ms-3">Valider l'axe de démoulage</button>
      </div>`;
  }

  _bind() {
    this.el.querySelectorAll('input[name="axis"]').forEach(r => {
      r.addEventListener('change', () => {
        this.state.axis = r.value;
        this.dispatchEvent(new CustomEvent('change', { detail: this.getValue() }));
      });
    });
    this.el.querySelector('#axisInvert').addEventListener('change', (e) => {
      this.state.direction = e.target.checked ? -1 : 1;
      this.dispatchEvent(new CustomEvent('change', { detail: this.getValue() }));
    });
    this.el.querySelector('#axisPreviewBtn').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('preview', { detail: this.getValue() }));
    });
    this.el.querySelector('#axisClearBtn').addEventListener('click', () => {
      this.dispatchEvent(new Event('clear'));
    });
    this.el.querySelector('#axisConfirmBtn').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('confirm', { detail: this.getValue() }));
    });
  }

  getValue() {
    return { axis: this.state.axis, direction: this.state.direction };
  }

  setValue({ axis, direction }) {
    if (axis) {
      const input = this.el.querySelector(`input[name="axis"][value="${axis}"]`);
      if (input) {
        input.checked = true;
        this.state.axis = axis;
      }
    }
    if (typeof direction === 'number') {
      this.el.querySelector('#axisInvert').checked = direction < 0;
      this.state.direction = direction < 0 ? -1 : 1;
    }
  }
}

export default AxisPicker;
