/* ============================================================
   history.js
   Undo/Redo 히스토리 시스템
   스냅샷 기반 상태 관리
   ============================================================ */

const History = (() => {
  const MAX_HISTORY = 50;
  let _stack = [];
  let _pointer = -1;
  let _onChange = null;

  function init(onChange) {
    _onChange = onChange;
    _stack = [];
    _pointer = -1;
  }

  /**
   * 현재 상태를 히스토리에 저장
   */
  function push(state, description = '') {
    // pointer 이후의 히스토리 제거
    _stack = _stack.slice(0, _pointer + 1);

    // 깊은 복사
    const snapshot = JSON.parse(JSON.stringify(state));
    _stack.push({ state: snapshot, description, timestamp: Date.now() });

    // 최대 크기 제한
    if (_stack.length > MAX_HISTORY) {
      _stack.shift();
    }

    _pointer = _stack.length - 1;
    updateButtons();
  }

  /**
   * Undo
   */
  function undo() {
    if (!canUndo()) return null;
    _pointer--;
    const entry = _stack[_pointer];
    updateButtons();
    if (_onChange) _onChange(JSON.parse(JSON.stringify(entry.state)), 'undo');
    return entry.state;
  }

  /**
   * Redo
   */
  function redo() {
    if (!canRedo()) return null;
    _pointer++;
    const entry = _stack[_pointer];
    updateButtons();
    if (_onChange) _onChange(JSON.parse(JSON.stringify(entry.state)), 'redo');
    return entry.state;
  }

  function canUndo() {
    return _pointer > 0;
  }

  function canRedo() {
    return _pointer < _stack.length - 1;
  }

  function updateButtons() {
    const undoBtn = document.getElementById('btnUndo');
    const redoBtn = document.getElementById('btnRedo');
    if (undoBtn) {
      undoBtn.style.opacity = canUndo() ? '1' : '0.3';
      undoBtn.style.pointerEvents = canUndo() ? 'auto' : 'none';
    }
    if (redoBtn) {
      redoBtn.style.opacity = canRedo() ? '1' : '0.3';
      redoBtn.style.pointerEvents = canRedo() ? 'auto' : 'none';
    }
  }

  function clear() {
    _stack = [];
    _pointer = -1;
    updateButtons();
  }

  function getHistoryInfo() {
    return {
      total: _stack.length,
      current: _pointer,
      canUndo: canUndo(),
      canRedo: canRedo(),
    };
  }

  return { init, push, undo, redo, canUndo, canRedo, clear, getHistoryInfo };
})();
