import { loadCatalog } from '../../registers/catalog.js';
import { formatTable, printSection, type OutputFormat, type Column, c } from '../format.js';

export interface CatalogOptions {
  level?: number;
  type?: 'read' | 'hold';
  search?: string;
  format: OutputFormat;
}

export function runCatalog(options: CatalogOptions): void {
  const catalog = loadCatalog();
  let registers = catalog.getAll();

  if (options.level != null) {
    registers = registers.filter((r) => r.level <= options.level!);
  }
  if (options.type) {
    registers = registers.filter((r) => r.type === options.type);
  }
  if (options.search) {
    const term = options.search.toLowerCase();
    registers = registers.filter((r) => r.name.toLowerCase().includes(term));
  }

  const columns: Column[] = [
    { key: 'name', label: 'Name' },
    { key: 'address', label: 'Addr', align: 'right' },
    { key: 'type', label: 'Type' },
    { key: 'level', label: 'Lvl', align: 'right' },
    { key: 'dataType', label: 'DataType' },
    { key: 'unit', label: 'Unit' },
    { key: 'group', label: 'Group' },
  ];

  const rows = registers.map((r) => ({
    name: r.name,
    address: r.address,
    type: r.type,
    level: r.level,
    dataType: r.arrayLength > 1 ? `${r.baseDataType}[${r.arrayLength}]` : r.baseDataType,
    unit: r.unit ?? '',
    group: Array.isArray(r.group) ? r.group.join(', ') : r.group ?? '',
  }));

  const total = catalog.getAll().length;

  if (options.format === 'pretty') {
    printSection('Register Catalog');
  }
  console.log(formatTable({ columns, rows }, options.format));
  if (options.format === 'pretty') {
    const filters: string[] = [];
    if (options.level != null) filters.push(`level <= ${options.level}`);
    if (options.type) filters.push(`type = ${options.type}`);
    if (options.search) filters.push(`search = "${options.search}"`);
    const filterText = filters.length > 0 ? ` (${filters.join(', ')})` : '';
    console.log(c.dim(`\n${registers.length} of ${total} registers${filterText}`));
  }
}
