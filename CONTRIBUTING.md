# Contributing to Serial Web Viewer

First off, thank you for considering contributing to Serial Web Viewer! 🎉

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Style Guidelines](#style-guidelines)

## 📜 Code of Conduct

This project and everyone participating in it is governed by our commitment to providing a welcoming and inclusive environment. Please be respectful and constructive in all interactions.

## 🤔 How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates.

**When creating a bug report, include:**
- Clear and descriptive title
- Steps to reproduce the issue
- Expected vs actual behavior
- Screenshots if applicable
- Your environment (OS, Node.js version, browser)

### Suggesting Features

Feature suggestions are welcome! Please provide:
- Clear description of the feature
- Use case / problem it solves
- Possible implementation approach (optional)

### Code Contributions

1. Look for issues labeled `good first issue` or `help wanted`
2. Comment on the issue to let others know you're working on it
3. Fork and create a feature branch
4. Submit a pull request

## 🛠️ Development Setup

```bash
# Fork and clone the repository
git clone https://github.com/YOUR_USERNAME/serial-web-viewer.git
cd serial-web-viewer

# Install dependencies
npm install

# Start development server
npm run dev

# The app will be available at http://localhost:3000
```

### Testing Without Hardware

Use the built-in **Test Mode** to simulate serial data without an Arduino.

## 🔄 Pull Request Process

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write clean, readable code
   - Add comments for complex logic
   - Update documentation if needed

3. **Commit with descriptive messages**
   ```bash
   git commit -m "feat: add data export functionality"
   ```
   
   Use conventional commits:
   - `feat:` New feature
   - `fix:` Bug fix
   - `docs:` Documentation
   - `style:` Formatting
   - `refactor:` Code restructuring
   - `test:` Adding tests
   - `chore:` Maintenance

4. **Push and create PR**
   ```bash
   git push origin feature/your-feature-name
   ```

5. **Fill out the PR template**
   - Describe your changes
   - Link related issues
   - Add screenshots if UI changes

## 📝 Style Guidelines

### JavaScript

- Use ES6+ features (const/let, arrow functions, template literals)
- Use meaningful variable and function names
- Add JSDoc comments for functions
- Keep functions small and focused

```javascript
// Good
const calculateTemperature = (rawValue) => {
  return rawValue * 0.48828125;
};

// Avoid
const calc = (v) => v * 0.48828125;
```

### CSS

- Use CSS custom properties (variables)
- Follow BEM-like naming convention
- Mobile-first approach
- Group related properties

```css
/* Good */
.card-header {
  /* Layout */
  display: flex;
  align-items: center;
  
  /* Spacing */
  padding: var(--spacing-lg);
  
  /* Visual */
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}
```

### HTML

- Use semantic elements
- Include accessibility attributes
- Keep markup clean and readable

## 🎯 Priority Areas

We especially welcome contributions in these areas:

- [ ] Unit tests
- [ ] TypeScript migration
- [ ] Accessibility improvements
- [ ] Performance optimizations
- [ ] Documentation
- [ ] Internationalization (i18n)

## ❓ Questions?

Feel free to open an issue with the `question` label or reach out to the maintainers.

---

Thank you for contributing! 🙌

