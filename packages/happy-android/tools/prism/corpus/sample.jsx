// A component with props
import React from 'react';
export function Card({ title, items = [] }) {
  const count = items.length * 2;
  return (
    <div className="card" data-count={count}>
      <h1>{title ?? "Untitled"}</h1>
      {items.map((item) => <Item key={item.id} {...item} />)}
    </div>
  );
}
