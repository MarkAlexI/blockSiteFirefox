import { t } from '../scripts/t.js';
import { CATEGORIES } from '../rules/categoryManager.js';

export class CategoryUIManager {
  static updateCategoryGrid(container, rules, disabledCategories, onToggle) {
    container.innerHTML = '';
    
    CATEGORIES.forEach(category => {
      const card = document.createElement('div');
      const isMuted = disabledCategories.includes(category);
      card.className = `category-card ${isMuted ? 'muted' : ''}`;
      
      const count = rules.filter(r => r.category === category).length;
      
      if (count === 0 && isMuted) return;
      
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !disabledCategories.includes(category);
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        onToggle(category);
      });
      checkbox.title = t('toggle_category_blocking') || 'Toggle blocking for this entire category';
      
      const name = document.createElement('span');
      name.className = 'category-name';
      name.textContent = t(`category_${category}`) || category;
      
      const countSpan = document.createElement('span');
      countSpan.className = 'category-count';
      countSpan.textContent = count;
      
      card.addEventListener('click', () => checkbox.click());
      
      card.appendChild(checkbox);
      card.appendChild(name);
      card.appendChild(countSpan);
      container.appendChild(card);
    });
  }
}