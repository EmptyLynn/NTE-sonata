const fs = require('fs');
let h = fs.readFileSync('renderer/index.html', 'utf8');
let u = fs.readFileSync('renderer/js/ui.js', 'utf8');

// 4. 瀑布流配色加自定义颜色输入
var pairAnchor = '<div class="pair-row" id="wf-pairs">';
var pr = h.indexOf(pairAnchor);
if (pr !== -1) {
  var closeDiv = h.indexOf('</div>', pr + pairAnchor.length);
  var customPair = [
    '        <div class="set-row" style="margin-top:8px;">',
    '          <span class="set-label">自定义</span>',
    '          <span style="display:inline-flex;align-items:center;gap:6px;">',
    '            <span style="font-size:11px;color:var(--ink-faint)">主旋律</span>',
    '            <input type="color" id="wf-custom-melody" value="#e9576e" style="width:28px;height:28px;border:none;border-radius:50%;cursor:pointer">',
    '            <span style="font-size:11px;color:var(--ink-faint)">伴奏</span>',
    '            <input type="color" id="wf-custom-acc" value="#4f7cf0" style="width:28px;height:28px;border:none;border-radius:50%;cursor:pointer">',
    '          </span>',
    '        </div>',
  ].join('\n');
  var insertPos = h.indexOf('\n', closeDiv) + 1;
  h = h.slice(0, insertPos) + customPair + '\n' + h.slice(insertPos);
}

// 5. 主题色加自定义颜色输入
var themeAnchor = '<div class="swatch-row" id="theme-swatches">';
var tr = h.indexOf(themeAnchor);
if (tr !== -1) {
  var themeClose = h.indexOf('</div>', tr + themeAnchor.length);
  var customTheme = [
    '        <div class="set-row" style="margin-top:8px;">',
    '          <span class="set-label">自定义</span>',
    '          <input type="color" id="theme-custom" value="#e9576e" style="width:28px;height:28px;border:none;border-radius:50%;cursor:pointer">',
    '        </div>',
  ].join('\n');
  var insertPos2 = h.indexOf('\n', themeClose) + 1;
  h = h.slice(0, insertPos2) + customTheme + '\n' + h.slice(insertPos2);
}
fs.writeFileSync('renderer/index.html', h);

// 6. ui.js 接线自定义颜色输入
var wire = [
  '',
  '      /* 自定义颜色输入 */',
  "      var wfMelodyInput = document.getElementById('wf-custom-melody');",
  "      var wfAccInput = document.getElementById('wf-custom-acc');",
  "      var themeCustomInput = document.getElementById('theme-custom');",
  '      if (wfMelodyInput && wfAccInput) {',
  "        var applyWFCustom = function() { UI.applyNoteColors(wfMelodyInput.value, wfAccInput.value); UI.saveSettings(); };",
  "        wfMelodyInput.addEventListener('input', applyWFCustom);",
  "        wfAccInput.addEventListener('input', applyWFCustom);",
  '      }',
  '      if (themeCustomInput) {',
  "        themeCustomInput.addEventListener('input', function() { UI.applyAccent(themeCustomInput.value); UI.saveSettings(); });",
  '      }',
].join('\n');
var wireAnchor = "      document.getElementById('set-guitar-sustain').addEventListener('click', () => {";
if (u.includes(wireAnchor) && !u.includes('wf-custom-melody')) {
  u = u.replace(wireAnchor, wire + '\n' + wireAnchor);
}
fs.writeFileSync('renderer/js/ui.js', u);
console.log('custom inputs added:', h.includes('wf-custom-melody'), u.includes('wf-custom-melody'));
