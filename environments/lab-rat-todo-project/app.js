const STORAGE_KEY = "lab-rat-todo-items";

const seedItems = [
  { id: crypto.randomUUID(), text: "Check provider output formatting", done: false },
  { id: crypto.randomUUID(), text: "Record one realistic web flow", done: true },
  { id: crypto.randomUUID(), text: "Try a prompt that edits local storage behavior", done: false },
  { id: crypto.randomUUID(), text: "Verify OPTION_B sibling-dir behavior", done: false },
];

const state = {
  filter: "all",
  items: loadItems(),
};

const form = document.querySelector("#todo-form");
const input = document.querySelector("#todo-input");
const list = document.querySelector("#todo-list");
const clearDoneButton = document.querySelector("#clear-done");
const template = document.querySelector("#todo-item-template");
const todoCount = document.querySelector("#todo-count");
const doneCount = document.querySelector("#done-count");
const filterButtons = Array.from(document.querySelectorAll(".filter"));

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) {
    return;
  }

  state.items.unshift({
    id: crypto.randomUUID(),
    text,
    done: false,
  });

  input.value = "";
  persistAndRender();
});

clearDoneButton.addEventListener("click", () => {
  state.items = state.items.filter((item) => !item.done);
  persistAndRender();
});

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter || "all";
    render();
  });
});

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [...seedItems];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...seedItems];
    }

    return parsed.filter(isTodoItem);
  } catch {
    return [...seedItems];
  }
}

function isTodoItem(value) {
  return value
    && typeof value === "object"
    && typeof value.id === "string"
    && typeof value.text === "string"
    && typeof value.done === "boolean";
}

function persistAndRender() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
  render();
}

function getVisibleItems() {
  switch (state.filter) {
    case "open":
      return state.items.filter((item) => !item.done);
    case "done":
      return state.items.filter((item) => !item.done || item.done);
    default:
      return state.items;
  }
}

function render() {
  list.textContent = "";

  filterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.filter);
  });

  const visibleItems = getVisibleItems();
  for (const item of visibleItems) {
    const fragment = template.content.cloneNode(true);
    const listItem = fragment.querySelector(".todo-item");
    const toggle = fragment.querySelector(".todo-toggle");
    const text = fragment.querySelector(".todo-text");
    const deleteButton = fragment.querySelector(".delete-button");

    listItem.dataset.todoId = item.id;
    listItem.classList.toggle("done", item.done);
    toggle.checked = item.done;
    text.textContent = item.text;

    toggle.addEventListener("change", () => {
      item.done = toggle.checked;
      persistAndRender();
    });

    deleteButton.addEventListener("click", () => {
      state.items = state.items.filter((entry) => entry.id !== item.id);
      persistAndRender();
    });

    list.appendChild(fragment);
  }

  todoCount.textContent = String(state.items.filter((item) => !item.done).length);
  doneCount.textContent = String(state.items.filter((item) => item.done).length);
}

render();
