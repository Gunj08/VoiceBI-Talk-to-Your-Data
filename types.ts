
export interface SaleRecord {
  id: string;
  date: string;
  revenue: number;
  units: number;
  category: string;
  region: string;
  customerType: 'New' | 'Returning';
}

export interface ChartDataPoint {
  label: string;
  value: number;
  secondary?: number;
}

export type ChartType = 'bar' | 'line' | 'area' | 'pie';

export interface BIResponse {
  insight: string;
  data: ChartDataPoint[];
  chartType: ChartType;
  title: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}
