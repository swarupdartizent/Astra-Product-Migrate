import {
  columnResizingFeature,
  columnSizingFeature,
  createColumnHelper,
  createSortedRowModel,
  metaHelper,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  type ColumnDef,
  type RowData,
} from '@tanstack/react-table';

/** Per-column presentation hints understood by <DataTable>. */
export interface DataTableColumnMeta {
  /** Right-align numbers and amounts. */
  align?: 'start' | 'end';
  /** Render cells in monospace (ids, versions, codes). */
  mono?: boolean;
}

/**
 * The feature set every DataTable uses: client-side sorting, column sizing and resizing.
 * Defined once at module scope, as TanStack Table v9 requires stable feature objects.
 */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
    datetime: sortFn_datetime,
    basic: sortFn_basic,
  },
  columnSizingFeature,
  columnResizingFeature,
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

export type DataTableFeatures = typeof dataTableFeatures;

// TValue is erased on purpose so heterogeneous columns fit one array.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataTableColumn<TData extends RowData> = ColumnDef<DataTableFeatures, TData, any>;

/**
 * Typed column builder for a DataTable row type. Define columns at module scope:
 *
 *   const col = createDataTableColumns<RoleAssignment>();
 *   const columns = col.columns([col.accessor('role_label', { header: 'Role' })]);
 */
export function createDataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}
