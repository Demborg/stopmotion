const SLIDER_STEPS = 1000;
const EXPOSURE_TIME_UNITS_PER_SECOND = 10_000;
const CENTIMETRES_PER_METRE = 100;
const KELVIN_DISPLAY_STEP = 50;

export const DEFAULT_CONTROLS = {
  focus: { manual: false, distance: 0.5 },
  exposure: { manual: false, time: EXPOSURE_TIME_UNITS_PER_SECOND / 60, iso: 100 },
  whiteBalance: { manual: false, kelvin: 4500 },
  zoom: { manual: true, level: 1 },
};

export function withDefaults(saved) {
  return Object.fromEntries(Object.entries(DEFAULT_CONTROLS).map(([group, defaults]) => [group, { ...defaults, ...saved?.[group] }]));
}

const logarithmic = (range) => ({
  toSlider: (value) => SLIDER_STEPS * Math.log(value / range.min) / Math.log(range.max / range.min),
  fromSlider: (position) => range.min * (range.max / range.min) ** (position / SLIDER_STEPS),
});

const linear = (range) => ({
  toSlider: (value) => (SLIDER_STEPS * (value - range.min)) / (range.max - range.min),
  fromSlider: (position) => range.min + ((range.max - range.min) * position) / SLIDER_STEPS,
});

const nearToFar = (range) => {
  const nearest = 1 / range.min;
  const farthest = 1 / range.max;
  return {
    toSlider: (distance) => (SLIDER_STEPS * (nearest - 1 / distance)) / (nearest - farthest),
    fromSlider: (position) => 1 / (nearest - ((nearest - farthest) * position) / SLIDER_STEPS),
  };
};

const formatDistance = (metres) =>
  metres < 1 ? `${Math.round(metres * CENTIMETRES_PER_METRE)} cm` : `${metres.toFixed(2)} m`;

const formatShutter = (time) => time >= EXPOSURE_TIME_UNITS_PER_SECOND
  ? `${(time / EXPOSURE_TIME_UNITS_PER_SECOND).toFixed(1)} s`
  : `1/${Math.round(EXPOSURE_TIME_UNITS_PER_SECOND / time)} s`;

const ROWS = [
  { label: 'Focus', group: 'focus', key: 'distance', range: 'focusDistance', scale: nearToFar, format: formatDistance, hasAutoToggle: true },
  { label: 'Shutter', group: 'exposure', key: 'time', range: 'exposureTime', scale: logarithmic, format: formatShutter, hasAutoToggle: true },
  { label: 'ISO', group: 'exposure', key: 'iso', range: 'iso', scale: logarithmic, format: (iso) => String(Math.round(iso)) },
  { label: 'White bal.', group: 'whiteBalance', key: 'kelvin', range: 'colorTemperature', scale: linear, format: (kelvin) => `${Math.round(kelvin / KELVIN_DISPLAY_STEP) * KELVIN_DISPLAY_STEP} K`, hasAutoToggle: true },
  { label: 'Zoom', group: 'zoom', key: 'level', range: 'zoom', scale: linear, format: (level) => `${level.toFixed(1)}×` },
];

export class ControlsPanel {
  #container;
  #onChange;
  #rows = [];
  #rangesKey = '';
  #controls = DEFAULT_CONTROLS;

  constructor(container, onChange) {
    this.#container = container;
    this.#onChange = onChange;
  }

  render(ranges, controls) {
    if (!ranges || !controls) return;
    this.#controls = controls;
    const rangesKey = JSON.stringify(ranges);
    if (rangesKey !== this.#rangesKey) this.#build(ranges, rangesKey);
    for (const row of this.#rows) this.#update(row);
  }

  #build(ranges, rangesKey) {
    this.#rangesKey = rangesKey;
    this.#rows = ROWS.filter((row) => ranges[row.range]).map((row) => this.#buildRow(row, ranges[row.range]));
    this.#container.replaceChildren(...this.#rows.map((row) => row.element));
    if (!this.#rows.length) this.#container.textContent = 'This camera offers no manual controls in the browser.';
  }

  #buildRow(row, range) {
    const element = document.createElement('div');
    element.className = 'control';
    const label = document.createElement('span');
    label.textContent = row.label;
    const autoToggle = document.createElement('button');
    autoToggle.textContent = 'Auto';
    autoToggle.hidden = !row.hasAutoToggle;
    const slider = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: SLIDER_STEPS, step: 1 });
    const output = document.createElement('output');
    element.append(label, autoToggle, slider, output);
    const scale = row.scale(range);
    autoToggle.onclick = () => this.#change(row.group, { manual: !this.#controls[row.group].manual });
    slider.oninput = () => {
      const value = scale.fromSlider(+slider.value);
      output.textContent = row.format(value);
      this.#change(row.group, { manual: true, [row.key]: value });
    };
    return { ...row, element, autoToggle, slider, output, scale };
  }

  #update(row) {
    const group = this.#controls[row.group];
    row.element.classList.toggle('auto', !group.manual);
    row.autoToggle.classList.toggle('on', !group.manual);
    if (document.activeElement !== row.slider) row.slider.value = row.scale.toSlider(group[row.key]);
    row.output.textContent = group.manual ? row.format(group[row.key]) : 'auto';
  }

  #change(group, values) {
    const change = { [group]: { ...this.#controls[group], ...values } };
    this.#controls = { ...this.#controls, ...change };
    for (const row of this.#rows) this.#update(row);
    this.#onChange(change);
  }
}
