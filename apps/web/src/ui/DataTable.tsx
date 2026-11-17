import { useTable, type RowData, type SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { dataTableFeatures, type DataTableColumn } from './data-table';
import styles from './DataTable.module.css';
import { Skeleton } from './Skeleton';

const EMPTY: never[] = [];
const DEFAULT_COLUMN = { size: 180, minSize: 64, maxSize: 800 };
const KEYBOARD_RESIZE_STEP = 16;

export interface DataTableProps<TData extends RowData> {
  /** Rows. Pass undefined while the first load is in flight. */
  data: readonly TData[] | undefined;
  /** Columns built with createDataTableColumns(); keep the array stable (module scope or memo). */
  columns: DataTableColumn<TData>[];
  /** Stable row identity (database id), never the array index. */
  getRowId: (row: TData) => string;
  /** Accessible name for the table (rendered as a visually hidden caption). */
  label: string;
  loading?: boolean;
  /** Number of skeleton rows while loading. */
  skeletonRows?: number;
  /** Shown when loaded and there are no rows. Usually an <EmptyState compact />. */
  empty?: ReactNode;
  /** Row activation by click or Enter. Rows become focusable when set. */
  onRowClick?: (row: TData) => void;
  initialSorting?: SortingState;
  /** Allow dragging (or arrow keys on the handle) to resize columns. Default true. */
  resizable?: boolean;
  /** Constrain height; the header stays sticky while the body scrolls. */
  maxHeight?: CSSProperties['maxHeight'];
  className?: string;
}

function ariaSort(sorted: false | 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
  if (sorted === 'asc') return 'ascending';
  if (sorted === 'desc') return 'descending';
  return 'none';
}

export function DataTable<TData extends RowData>({
  data,
  columns,
  getRowId,
  label,
  loading = false,
  skeletonRows = 5,
  empty,
  onRowClick,
  initialSorting,
  resizable = true,
  maxHeight,
  className,
}: DataTableProps<TData>) {
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data: data ?? EMPTY,
    getRowId: (row) => getRowId(row),
    defaultColumn: DEFAULT_COLUMN,
    columnResizeMode: 'onChange',
    enableColumnResizing: resizable,
    enableSortingRemoval: true,
    ...(initialSorting ? { initialState: { sorting: initialSorting } } : {}),
  });

  const rows = table.getRowModel().rows;
  const leafColumns = table.getAllLeafColumns();
  const showSkeleton = loading && rows.length === 0;
  const showEmpty = !loading && rows.length === 0;

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: TData) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRowClick?.(row);
    }
  }

  return (
    <div
      className={cx(styles.wrapper, className)}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
      aria-busy={loading || undefined}
    >
      <table className={styles.table} style={{ width: table.getTotalSize(), minWidth: '100%' }}>
        <caption className="sr-only">
          {label}
          {loading ? ' (loading)' : ''}
        </caption>
        <colgroup>
          {leafColumns.map((column) => (
            <col key={column.id} style={{ width: column.getSize() }} />
          ))}
        </colgroup>
        <thead className={styles.thead}>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const column = header.column;
                const meta = column.columnDef.meta;
                const canSort = column.getCanSort();
                const sorted = column.getIsSorted();
                const toggle = column.getToggleSortingHandler();
                const content = header.isPlaceholder ? null : <table.FlexRender header={header} />;
                return (
                  <th
                    key={header.id}
                    scope="col"
                    colSpan={header.colSpan}
                    aria-sort={canSort ? ariaSort(sorted) : undefined}
                    className={cx(styles.th, meta?.align === 'end' && styles.alignEnd)}
                  >
                    {canSort ? (
                      <button type="button" className={styles.sortButton} onClick={toggle}>
                        <span className={styles.headerText}>{content}</span>
                        <span className={styles.sortIcon} aria-hidden="true" data-active={!!sorted}>
                          {sorted === 'asc' ? (
                            <ArrowUp />
                          ) : sorted === 'desc' ? (
                            <ArrowDown />
                          ) : (
                            <ChevronsUpDown />
                          )}
                        </span>
                      </button>
                    ) : (
                      <span className={styles.headerText}>{content}</span>
                    )}
                    {resizable && column.getCanResize() ? (
                      // A focusable separator is an interactive ARIA widget (window splitter).
                      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id} column`}
                        aria-valuenow={column.getSize()}
                        aria-valuemin={column.columnDef.minSize ?? DEFAULT_COLUMN.minSize}
                        aria-valuemax={column.columnDef.maxSize ?? DEFAULT_COLUMN.maxSize}
                        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                        tabIndex={0}
                        className={styles.resizer}
                        data-resizing={column.getIsResizing() || undefined}
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        onDoubleClick={() => column.resetSize()}
                        onKeyDown={(event) => {
                          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                          event.preventDefault();
                          const delta =
                            event.key === 'ArrowLeft'
                              ? -KEYBOARD_RESIZE_STEP
                              : KEYBOARD_RESIZE_STEP;
                          const min = column.columnDef.minSize ?? DEFAULT_COLUMN.minSize;
                          const max = column.columnDef.maxSize ?? DEFAULT_COLUMN.maxSize;
                          const next = Math.min(max, Math.max(min, column.getSize() + delta));
                          table.setColumnSizing((old) => ({ ...old, [column.id]: next }));
                        }}
                      />
                    ) : null}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {showSkeleton
            ? Array.from({ length: skeletonRows }, (_, index) => (
                <tr key={`skeleton-${index}`} className={styles.tr}>
                  {leafColumns.map((column) => (
                    <td key={column.id} className={styles.td}>
                      <Skeleton width={`${55 + ((index * 17 + column.id.length * 7) % 35)}%`} />
                    </td>
                  ))}
                </tr>
              ))
            : null}
          {showEmpty ? (
            <tr>
              <td colSpan={leafColumns.length} className={styles.emptyCell}>
                {empty ?? <p className={styles.emptyText}>No rows to show.</p>}
              </td>
            </tr>
          ) : null}
          {rows.map((row) => {
            const original = row.original;
            const interactive = onRowClick !== undefined;
            return (
              // Rows act as a mouse/keyboard shortcut; the row's primary cell should still
              // contain a real link when the target is a page.
              <tr
                key={row.id}
                className={cx(styles.tr, interactive && styles.clickable)}
                tabIndex={interactive ? 0 : undefined}
                onClick={interactive ? () => onRowClick(original) : undefined}
                onKeyDown={interactive ? (event) => onRowKeyDown(event, original) : undefined}
              >
                {row.getAllCells().map((cell) => {
                  const meta = cell.column.columnDef.meta;
                  return (
                    <td
                      key={cell.id}
                      className={cx(
                        styles.td,
                        meta?.align === 'end' && styles.alignEnd,
                        meta?.mono && styles.mono,
                      )}
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
