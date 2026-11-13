// Task Tracker — vanilla ES module, no dependencies.

const STORAGE_KEY = 'task-tracker.tasks';

/** @typedef {{ id: string, title: string, done: boolean }} Task */

/** @type {Task[]} */
let tasks = [];
/** @type {'all' | 'active' | 'done'} */
let filter = 'all';

const form = document.getElementById('task-form');
const input = document.getElementById('task-input');
const errorEl = document.getElementById('form-error');
const listEl = document.getElementById('task-list');
const counterEl = document.getElementById('counter');
const emptyEl = document.getElementById('empty-state');
const filterButtons = Array.from(document.querySelectorAll('.filter'));

/* ---------------- storage ---------------- */

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.title === 'string')
      .map((t) => ({
        id: typeof t.id === 'string' && t.id ? t.id : createId(),
        title: t.title,
        done: Boolean(t.done),
      }));
  } catch (err) {
    console.warn('Task Tracker: could not read stored tasks.', err);
    return [];
  }
}

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (err) {
    console.warn('Task Tracker: could not persist tasks.', err);
  }
}

function createId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ---------------- actions ---------------- */

function addTask(title) {
  tasks.push({ id: createId(), title, done: false });
  saveTasks();
  render();
}

function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.done = !task.done;
  clearError();
  saveTasks();
  render();
}

function deleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  clearError();
  saveTasks();
  render();
}

function setFilter(next) {
  // Any successful action dismisses a stale inline validation message.
  clearError();
  filter = next;
  for (const button of filterButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === next));
  }
  render();
}

function visibleTasks() {
  if (filter === 'active') return tasks.filter((t) => !t.done);
  if (filter === 'done') return tasks.filter((t) => t.done);
  return tasks;
}

/* ---------------- rendering ---------------- */

function createTaskElement(task) {
  const li = document.createElement('li');
  li.className = task.done ? 'done' : 'active';
  li.dataset.id = task.id;

  // Toggle: a real <button> with aria-pressed so it is keyboard usable.
  // Title is attached with textContent -> user text is never parsed as HTML.
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'task-toggle';
  toggle.setAttribute('aria-pressed', String(task.done));
  toggle.addEventListener('click', () => toggleTask(task.id));

  // Empty span: CSS draws the box and checkmark, so no special glyphs are needed.
  const box = document.createElement('span');
  box.className = 'checkbox';
  box.setAttribute('aria-hidden', 'true');

  const title = document.createElement('span');
  title.className = 'task-title';
  title.textContent = task.title; // escaped by construction

  toggle.append(box, title);

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'delete';
  deleteButton.textContent = 'Delete';
  deleteButton.setAttribute('aria-label', `Delete task: ${task.title}`);
  deleteButton.addEventListener('click', () => deleteTask(task.id));

  li.append(toggle, deleteButton);
  return li;
}

function render() {
  const shown = visibleTasks();

  listEl.replaceChildren(...shown.map(createTaskElement));

  const activeCount = tasks.filter((t) => !t.done).length;
  counterEl.textContent = `${activeCount} item${activeCount === 1 ? '' : 's'} left`;

  emptyEl.hidden = shown.length > 0;
  emptyEl.textContent =
    tasks.length === 0
      ? 'No tasks yet.'
      : filter === 'active'
        ? 'Nothing left to do.'
        : 'No completed tasks.';
}

/* ---------------- errors ---------------- */

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  input.setAttribute('aria-invalid', 'true');
  input.focus();
}

function clearError() {
  errorEl.textContent = '';
  errorEl.hidden = true;
  input.removeAttribute('aria-invalid');
}

/* ---------------- events ---------------- */

form.addEventListener('submit', (event) => {
  event.preventDefault(); // also covers Enter-key submission
  const title = input.value.trim();
  if (!title) {
    showError('Please enter a task title.');
    return;
  }
  clearError();
  addTask(title);
  input.value = '';
  input.focus();
});

input.addEventListener('input', () => {
  if (input.value.trim()) clearError();
});

for (const button of filterButtons) {
  button.addEventListener('click', () => setFilter(button.dataset.filter));
}

/* ---------------- startup ---------------- */

tasks = loadTasks();
setFilter('all');
