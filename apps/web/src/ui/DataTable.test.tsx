import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createDataTableColumns } from './data-table';
import { DataTable } from './DataTable';

interface Row {
  id: string;
  name: string;
  count: number;
}

const col = createDataTableColumns<Row>();
const columns = col.columns([
  col.accessor('name', { header: 'Name' }),
  col.accessor('count', { header: 'Count', meta: { align: 'end' } }),
]);

const rows: Row[] = [
  { id: 'b', name: 'Bravo', count: 2 },
  { id: 'a', name: 'Alpha', count: 10 },
  { id: 'c', name: 'Charlie', count: 1 },
];

function bodyNames(): string[] {
  const [, body] = screen.getAllByRole('rowgroup');
  return within(body!)
    .getAllByRole('row')
    .map((row) => within(row).getAllByRole('cell')[0]!.textContent ?? '');
}

describe('DataTable', () => {
  it('renders an accessible table and sorts by column', async () => {
    render(<DataTable label="Things" data={rows} columns={columns} getRowId={(r) => r.id} />);
    expect(screen.getByRole('table', { name: 'Things' })).toBeInTheDocument();
    expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie']);

    const nameHeader = screen.getByRole('columnheader', { name: /Name/ });
    await userEvent.click(within(nameHeader).getByRole('button'));
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyNames()).toEqual(['Alpha', 'Bravo', 'Charlie']);

    await userEvent.click(within(nameHeader).getByRole('button'));
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
    expect(bodyNames()).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('shows the empty state when there are no rows', () => {
    render(
      <DataTable
        label="Things"
        data={[]}
        columns={columns}
        getRowId={(r) => r.id}
        empty={<p>Nothing here yet</p>}
      />,
    );
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });

  it('shows skeleton rows and aria-busy while loading', () => {
    const { container } = render(
      <DataTable
        label="Things"
        data={undefined}
        columns={columns}
        getRowId={(r) => r.id}
        loading
        skeletonRows={3}
      />,
    );
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true');
    const [, body] = screen.getAllByRole('rowgroup');
    expect(within(body!).getAllByRole('row')).toHaveLength(3);
  });

  it('activates rows by click and keyboard', async () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        label="Things"
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        onRowClick={onRowClick}
      />,
    );
    const alphaRow = screen.getByText('Alpha').closest('tr')!;
    await userEvent.click(alphaRow);
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);

    const charlieRow = screen.getByText('Charlie').closest('tr')!;
    charlieRow.focus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenLastCalledWith(rows[2]);
  });

  it('resizes columns from the keyboard', async () => {
    render(<DataTable label="Things" data={rows} columns={columns} getRowId={(r) => r.id} />);
    const handle = screen.getByRole('separator', { name: 'Resize Name column' });
    const before = Number(handle.getAttribute('aria-valuenow'));
    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(Number(handle.getAttribute('aria-valuenow'))).toBe(before + 16);
  });
});
