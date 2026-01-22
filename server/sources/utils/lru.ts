class Node<T> {
    constructor(
        public value: T,
        public prev: Node<T> | null = null,
        public next: Node<T> | null = null
    ) {}
}

export class LRUSet<T> {
    private readonly maxSize: number;
    private readonly map: Map<T, Node<T>>;
    private head: Node<T> | null = null;
    private tail: Node<T> | null = null;

    constructor(maxSize: number) {
        if (maxSize <= 0) {
            throw new Error('LRUSet maxSize must be greater than 0');
        }
        this.maxSize = maxSize;
        this.map = new Map();
    }

    private moveToFront(node: Node<T>): void {
        if (node === this.head) return;

        // Remove from current position
        if (node.prev) node.prev.next = node.next;
        if (node.next) node.next.prev = node.prev;
        if (node === this.tail) this.tail = node.prev;

        // Move to front
        node.prev = null;
        node.next = this.head;
        if (this.head) this.head.prev = node;
        this.head = node;
        if (!this.tail) this.tail = node;
    }

    add(value: T): void {
        const existingNode = this.map.get(value);
        
        if (existingNode) {
            // Move to front (most recently used)
            this.moveToFront(existingNode);
            return;
        }

        // Create new node
        const newNode = new Node(value);
        this.map.set(value, newNode);

        // Add to front
        newNode.next = this.head;
        if (this.head) this.head.prev = newNode;
        this.head = newNode;
        if (!this.tail) this.tail = newNode;

        // Remove LRU if over capacity
        if (this.map.size > this.maxSize) {
            if (this.tail) {
                this.map.delete(this.tail.value);
                this.tail = this.tail.prev;
                if (this.tail) this.tail.next = null;
            }
        }
    }

    has(value: T): boolean {
        const node = this.map.get(value);
        if (node) {
            this.moveToFront(node);
            return true;
        }
        return false;
    }

    delete(value: T): boolean {
        const node = this.map.get(value);
        if (!node) return false;

        // Remove from linked list
        if (node.prev) node.prev.next = node.next;
        if (node.next) node.next.prev = node.prev;
        if (node === this.head) this.head = node.next;
        if (node === this.tail) this.tail = node.prev;

        return this.map.delete(value);
    }

    clear(): void {
        this.map.clear();
        this.head = null;
        this.tail = null;
    }

    get size(): number {
        return this.map.size;
    }

    *values(): IterableIterator<T> {
        let current = this.head;
        while (current) {
            yield current.value;
            current = current.next;
        }
    }

    toArray(): T[] {
        return Array.from(this.values());
    }
}