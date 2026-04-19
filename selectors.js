// All selectors in one place — update here when PlanHub UI changes

export const SEL = {
  auth: {
    email: { role: 'textbox', name: 'Email' },
    password: { role: 'textbox', name: 'Password' },
    signIn: { role: 'button', name: 'Sign In' },
  },
  dateFilter: {
    // The Material carousel arrow that needs multiple clicks to reveal "Custom"
    paginateArrow: '.mat-ripple.mat-tab-header-pagination.mat-tab-header-pagination-after',
    customTab: 'text=Custom',
  },
  project: {
    viewDetails: { role: 'button', name: 'View Project Details' },
    subcontractorsTab: { role: 'button', name: 'Subcontractors' },
  },
  company: {
    // TODO: dig this selector properly — current scraper uses broad text match
    // Inspect a real subcontractor page and update this
    row: '[class*="company"], [class*="subcontractor"] a',
  },
};
