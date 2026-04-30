// All selectors in one place — update here when PlanHub UI changes

export const SEL = {
  auth: {
    email: { role: 'textbox', name: 'Email' },
    password: { role: 'textbox', name: 'Password' },
    signIn: { role: 'button', name: 'Sign In' },
  },
  account: {
    profileImage: { role: 'img', name: 'Profile' },
    myAccount: { role: 'menuitem', name: 'My Account' },
    companySettingsButton: { role: 'button', name: 'Company Settings' },
    viewCompanySettingsLink: { role: 'link', name: 'View Company Settings' },
    zipCodeInput: { role: 'textbox', name: /Zip/i },
  },
  dateFilter: {
    paginateArrow: '.mat-ripple.mat-tab-header-pagination.mat-tab-header-pagination-after',
    customTab: 'text=Custom',
    distanceField: 'mat-form-field',
    distanceTrigger: '.mat-select-trigger',
    distanceOption: 'mat-option',
  },
  project: {
    viewDetails: { role: 'button', name: 'View Project Details' },
    subcontractorsTab: { role: 'button', name: 'Subcontractors' },
  },
  company: {
    row: '[class*="company"], [class*="subcontractor"] a',
  },
};
