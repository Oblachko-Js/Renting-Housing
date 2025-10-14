# AI Assistant Instructions for Renting-Housing Project

## Project Overview
This is a web application for renting housing, built with Express.js and PostgreSQL. The application includes real-time chat functionality using Socket.IO and supports email notifications.

## Architecture & Components

### Backend (`app.js`)
- Express.js server with Socket.IO integration for real-time features
- PostgreSQL database for data persistence
- Session-based authentication
- Email notifications system using nodemailer
- File upload handling with multer

### Frontend Structure
- Views (`/views/`): HTML templates for different pages
- Static assets (`/public/`):
  - CSS styles in `/public/css/`
  - Client-side JavaScript in `/public/js/`
  - Images in `/public/images/`

## Key Patterns & Conventions

### Database Interactions
- Uses `pg` Pool for connection management
- Lazy initialization pattern for database columns (see `ensureListingExtraColumns()`)
- SQL queries are written inline (no ORM)

### Authentication
- Session-based authentication using `express-session`
- Password hashing using `bcryptjs`
- Session data stored in `req.session.userId`

### Real-time Communication
- Socket.IO rooms named as `user_${userId}` for user-specific notifications
- Notification system combines both real-time updates and email notifications

### Frontend Views
- Pages follow naming convention: `<feature>_<action>.html` (e.g., `listing_edit.html`, `listing_view.html`)
- Common pages: `index.html`, `login.html`, `register.html`

## Development Setup
1. PostgreSQL database configuration required in `app.js`
2. Email notifications require SMTP configuration via environment variables:
   - SMTP_HOST
   - SMTP_PORT (defaults to 587)
   - SMTP_USER
   - SMTP_PASS
   - SMTP_FROM (optional)

## Common Tasks
- Adding new listing fields requires updating `ensureListingExtraColumns()`
- User notifications should use the `notifyUser(io, userId, payload)` helper
- Email notifications are handled by `emailUser(userId, subject, text)`

## Key Files for Reference
- `app.js`: Main application logic and server setup
- `views/chat_dialog.html`: Real-time chat implementation
- `public/js/main.js`: Client-side JavaScript functionality