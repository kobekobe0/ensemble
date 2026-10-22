// In-memory book store.
export function createStore(initial = []) {
  const books = new Map();
  let nextId = 1;

  const copy = (b) => ({ ...b, tags: [...b.tags] });

  function add(book) {
    const record = {
      id: nextId++,
      title: book.title,
      author: book.author,
      year: book.year,
      tags: book.tags ?? [],
    };
    books.set(record.id, record);
    return copy(record);
  }

  for (const b of initial) add(b);

  return {
    add,
    get(id) {
      const b = books.get(id);
      return b ? copy(b) : null;
    },
    list() {
      return [...books.values()].map(copy);
    },
    remove(id) {
      return books.delete(id);
    },
  };
}
