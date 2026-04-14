export const CATEGORIES = [
  'social',
  'news',
  'entertainment',
  'shopping',
  'work',
  'gaming',
  'adult',
  'uncategorized'
];

export class CategoryManager {
  static getCategories() {
    return CATEGORIES;
  }
}