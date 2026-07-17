import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">DLB Trust</div>
        <nav className="sidebar-nav">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/trusts">Trusts</NavLink>
          <NavLink to="/beneficiaries">Beneficiaries</NavLink>
          <NavLink to="/disbursements">Disbursements</NavLink>
        </nav>
        <div className="sidebar-footer">
          <div>{user?.name}</div>
          <div style={{ opacity: 0.7, fontSize: '0.75rem' }}>{user?.role}</div>
          <button onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
