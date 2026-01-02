
import { SaleRecord } from '../types';

const categories = ['Electronics', 'Home & Kitchen', 'Apparel', 'Books', 'Software'];
const regions = ['North America', 'Europe', 'Asia Pacific', 'Latin America'];

export const generateMockData = (): SaleRecord[] => {
  const data: SaleRecord[] = [];
  const now = new Date();
  
  for (let i = 0; i < 500; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - Math.floor(Math.random() * 90)); // Last 90 days
    
    data.push({
      id: Math.random().toString(36).substr(2, 9),
      date: date.toISOString().split('T')[0],
      revenue: Math.floor(Math.random() * 500) + 20,
      units: Math.floor(Math.random() * 10) + 1,
      category: categories[Math.floor(Math.random() * categories.length)],
      region: regions[Math.floor(Math.random() * regions.length)],
      customerType: Math.random() > 0.3 ? 'Returning' : 'New'
    });
  }
  
  return data.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
};

export const DB_SCHEMA_DESCRIPTION = `
Tables:
- sales:
    - id (string)
    - date (string, YYYY-MM-DD)
    - revenue (number, in USD)
    - units (number)
    - category (string: Electronics, Home & Kitchen, Apparel, Books, Software)
    - region (string: North America, Europe, Asia Pacific, Latin America)
    - customerType (string: New, Returning)
`;
