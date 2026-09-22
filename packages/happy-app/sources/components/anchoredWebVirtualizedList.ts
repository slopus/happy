/**
 * App-local compatibility adapter for react-native-web 0.21.2's VirtualizedList.
 * That version retains numeric render-mask indices across prepends, unlike newer
 * native lists. Stable keys alone therefore cannot keep a visible image mounted.
 * Keep the vendor's bounded mask/overscan, but translate the surviving range and
 * its measured scroll offset in the same React commit. No global vendor patch.
 * The real vendor-class test is an upgrade gate for these private internals.
 */
export function createAnchoredWebVirtualizedList(Base: any): any {
    if (typeof Base?._createRenderMask !== 'function' || typeof Base?.getDerivedStateFromProps !== 'function') {
        throw new Error('Unsupported Web transcript virtualizer: bounded anchor adapter requires review');
    }
    const key = (props: any, index: number): string => props.keyExtractor(props.getItem(props.data, index), index);
    return class AnchoredWebVirtualizedList extends Base {
        private appliedAnchorRevision = 0;
        constructor(props: any) {
            super(props);
            if (!this.state?.cellsAroundViewport || !this._scrollMetrics || typeof props.getItemLayout !== 'function') {
                throw new Error('Unsupported Web transcript virtualizer geometry');
            }
            this.state = { ...this.state, anchorProps: props, anchorRevision: 0,
                readAnchorOffset: () => this._scrollRef?.getScrollableNode?.()?.scrollTop ?? this._scrollMetrics.offset };
        }

        static getDerivedStateFromProps(props: any, previous: any): any {
            const base = Base.getDerivedStateFromProps(props, previous);
            const old = previous.anchorProps;
            const next = { ...base, anchorProps: props };
            if (!old || props.inverted || (old.data === props.data && old.getItemLayout === props.getItemLayout)) return next;
            const count = props.getItemCount(props.data);
            const oldCount = old.getItemCount(old.data);
            if (!count || !oldCount) return next;
            const indices = new Map<string, number>();
            for (let index = 0; index < count; index++) indices.set(key(props, index), index);
            const surviving: Array<{ old: number; next: number }> = [];
            const range = previous.cellsAroundViewport;
            for (let index = range.first; index <= Math.min(range.last, oldCount - 1); index++) {
                const nextIndex = indices.get(key(old, index));
                if (nextIndex !== undefined) surviving.push({ old: index, next: nextIndex });
            }
            if (!surviving.length) return next;
            // Render-mask translation is independent of scroll ownership. In
            // coordinated mode never read DOM or derive an estimated write here.
            if (props.scrollCoordinator) {
                const cells = { first: Math.min(...surviving.map(row => row.next)), last: Math.max(...surviving.map(row => row.next)) };
                return { ...next, cellsAroundViewport: cells, renderMask: Base._createRenderMask(props, cells) };
            }
            const offset = previous.readAnchorOffset();
            const anchor = surviving.find(row => {
                const frame = old.getItemLayout(old.data, row.old);
                return frame.offset + frame.length > offset;
            }) ?? surviving.at(-1)!;
            const delta = props.getItemLayout(props.data, anchor.next).offset - old.getItemLayout(old.data, anchor.old).offset;
            const cells = { first: Math.min(...surviving.map(row => row.next)), last: Math.max(...surviving.map(row => row.next)) };
            return { ...next, cellsAroundViewport: cells, renderMask: Base._createRenderMask(props, cells),
                ...(delta !== 0 ? { anchorRevision: previous.anchorRevision + 1, anchorOffset: Math.max(0, offset + delta) } : {}) };
        }

        getSnapshotBeforeUpdate(previous: any): { node: HTMLElement; offset: number; transaction?: number } | null {
            if (this.props.inverted) return null;
            const coordinator = this.props.scrollCoordinator;
            const transaction = coordinator?.history;
            if (coordinator && (!transaction || transaction.compensated || previous.data === this.props.data)) return null;
            if (transaction && this.props.historyBoundaryKeys?.[transaction.direction === 'older' ? 0 : 1] === transaction.key) return null;
            const scroll = this._scrollRef?.getScrollableNode?.() as HTMLElement | undefined;
            if (!scroll?.getBoundingClientRect || !scroll.querySelectorAll) return null;
            const viewport = scroll.getBoundingClientRect();
            const survivingKeys = new Set<string>();
            for (let index = 0; index < this.props.getItemCount(this.props.data); index++) survivingKeys.add(key(this.props, index));
            const survivingContent = new Set<string>();
            if (previous.data !== this.props.data) {
                for (let index = 0; index < this.props.getItemCount(this.props.data); index++) {
                    const item = this.props.getItem(this.props.data, index);
                    if (item?.type === 'message' || item?.type === 'image-group') survivingContent.add(key(this.props, index));
                }
            }
            let fallback: { node: HTMLElement; offset: number; transaction?: number } | null = null;
            let contentFallback: { node: HTMLElement; offset: number; transaction?: number } | null = null;
            for (const node of scroll.querySelectorAll<HTMLElement>('[data-transcript-key]')) {
                const nodeKey = node.getAttribute?.('data-transcript-key');
                if (nodeKey && !survivingKeys.has(nodeKey)) continue;
                const bounds = node.getBoundingClientRect();
                if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
                    const anchor = { node, offset: bounds.top - viewport.top, transaction: transaction?.id };
                    // Paging can split a summary while retaining its outer key.
                    // Keep the visible text/media below it in place, rather than
                    // pinning the summary and pushing the reading content away.
                    if (survivingContent.has(nodeKey ?? '')) {
                        const visibleHeight = Math.min(bounds.bottom, viewport.bottom) - Math.max(bounds.top, viewport.top);
                        if (visibleHeight >= Math.min(32, bounds.bottom - bounds.top)) return anchor;
                        contentFallback ??= anchor;
                    }
                    fallback ??= anchor;
                }
            }
            return contentFallback ?? fallback;
        }

        componentDidUpdate(previous: any, _state: any, snapshot: { node: HTMLElement; offset: number; transaction?: number } | null): void {
            const scroll = this._scrollRef?.getScrollableNode?.() as HTMLElement | undefined;
            const measured = snapshot?.node.isConnected && scroll?.getBoundingClientRect
                ? Math.max(0, scroll.scrollTop + snapshot.node.getBoundingClientRect().top
                    - scroll.getBoundingClientRect().top - snapshot.offset) : null;
            if (this.props.scrollCoordinator) {
                if (snapshot?.transaction !== undefined && measured !== null
                    && this.props.scrollCoordinator.compensate(snapshot.transaction, measured)) {
                    this._scrollMetrics = { ...this._scrollMetrics, offset: measured };
                    this.props.onAnchorOffsetChange?.(measured);
                }
                super.componentDidUpdate(previous);
                return;
            }
            if (measured !== null || this.appliedAnchorRevision !== this.state.anchorRevision) {
                const offset = measured ?? this.state.anchorOffset;
                // Real cells plus estimated spacers do not necessarily have the
                // cumulative estimated offset. Trust the retained DOM snapshot,
                // including any browser anchoring already performed this commit.
                // Update metrics before the vendor schedules its next mask, so
                // it cannot immediately discard the translated visible cells.
                this._scrollMetrics = { ...this._scrollMetrics, offset };
                if (!scroll || Math.abs(scroll.scrollTop - offset) > 0.5) this.scrollToOffset({ offset, animated: false });
                this.props.onAnchorOffsetChange?.(offset);
            }
            this.appliedAnchorRevision = this.state.anchorRevision;
            super.componentDidUpdate(previous);
        }
    };
}
