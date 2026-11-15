'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './page.module.css';
import { useSession } from 'next-auth/react';
import { useDate } from '@/context/DateContext';
import { MdGroup, MdPersonAdd } from 'react-icons/md';

interface UserRecord {
    id: string;
    username: string;
    name?: string | null;
    role: string;
    createdAt: string;
}

interface UserFormState {
    username: string;
    password: string;
    role: string;
    name: string;
}

interface SessionUser {
    id?: string;
    role?: string;
}

const INITIAL_FORM: UserFormState = {
    username: '',
    password: '',
    role: 'VIEWER',
    name: ''
};

function getRoleBadgeClass(role: string): string {
    if (role === 'ADMIN') return styles.pillAdmin;
    if (role === 'EDITOR') return styles.pillEditor;
    return styles.pillViewer;
}

export default function UserManagementPage() {
    const { data: session } = useSession();
    const { formatDate } = useDate();
    const [users, setUsers] = useState<UserRecord[]>([]);
    const [showForm, setShowForm] = useState(false);
    const [formData, setFormData] = useState<UserFormState>(INITIAL_FORM);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);

    const fetchUsers = useCallback(async (signal?: AbortSignal) => {
        try {
            const res = await fetch('/api/users', { signal });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setUsers(data);
            }
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            console.error('Failed to fetch users', err);
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        const run = async () => {
            await fetchUsers(controller.signal);
        };
        run();
        return () => controller.abort();
    }, [fetchUsers]);

    const resetForm = () => {
        setFormData(INITIAL_FORM);
        setEditingId(null);
        setShowForm(false);
        setError('');
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const url = editingId ? `/api/users/${editingId}` : '/api/users';
            const method = editingId ? 'PUT' : 'POST';

            const payload: Record<string, string> = {
                role: formData.role,
                name: formData.name
            };
            if (!editingId) {
                payload.username = formData.username;
                payload.password = formData.password;
            } else if (formData.password) {
                payload.password = formData.password;
            }

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || `HTTP ${res.status}`);
            }

            resetForm();
            await fetchUsers();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to save user.');
        } finally {
            setLoading(false);
        }
    };

    const handleEdit = (user: UserRecord) => {
        setFormData({
            username: user.username,
            password: '',
            role: user.role,
            name: user.name || ''
        });
        setEditingId(user.id);
        setShowForm(true);
        setError('');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Are you sure you want to delete this user?')) return;
        setError('');

        try {
            const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
            if (res.ok) {
                await fetchUsers();
            } else {
                const msg = await res.text();
                setError(msg || 'Failed to delete user.');
            }
        } catch (err) {
            console.error('Failed to delete user', err);
            setError('Network error while deleting user.');
        }
    };

    if (!session) {
        return (
            <section className={styles.card}>
                <div className={styles.errorBanner}>Unauthorized</div>
            </section>
        );
    }

    const sessionUser = session.user as SessionUser;
    const isAdmin = sessionUser.role === 'ADMIN';

    return (
        <section className={styles.card} aria-label="User management">
            <div className={styles.cardHeader}>
                <div className={styles.cardTitleGroup}>
                    <h2 className={styles.cardTitle}>
                        <MdGroup size={20} aria-hidden="true" />
                        User Management
                    </h2>
                    <p className={styles.cardSubheading}>
                        Manage workspace members and role permissions.
                    </p>
                </div>

                <div className={styles.headerActions}>
                    <span className={`${styles.pill} ${styles.pillViewer}`}>
                        {users.length} User{users.length === 1 ? '' : 's'}
                    </span>
                    {isAdmin && (
                        <button
                            type="button"
                            className={showForm && !editingId ? styles.cancelButton : styles.addButton}
                            onClick={() => {
                                if (showForm) resetForm();
                                else setShowForm(true);
                            }}
                        >
                            {!showForm && <MdPersonAdd size={18} aria-hidden="true" />}
                            {showForm ? 'Cancel' : 'Add User'}
                        </button>
                    )}
                </div>
            </div>

            {error && (
                <div role="alert" className={styles.errorBanner}>
                    {error}
                </div>
            )}

            {showForm && (
                <div className={styles.formCard}>
                    <form onSubmit={handleSubmit} className={styles.form}>
                        <div className={styles.inputGroup}>
                            <label htmlFor="user-name" className={styles.label}>Display Name</label>
                            <input
                                id="user-name"
                                type="text"
                                className={styles.input}
                                value={formData.name}
                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                placeholder="Display Name (Optional)"
                            />
                        </div>
                        <div className={styles.inputGroup}>
                            <label htmlFor="user-username" className={styles.label}>Username</label>
                            <input
                                id="user-username"
                                type="text"
                                className={styles.input}
                                value={formData.username}
                                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                                required
                                disabled={Boolean(editingId)}
                            />
                        </div>
                        <div className={styles.inputGroup}>
                            <label htmlFor="user-password" className={styles.label}>Password</label>
                            <input
                                id="user-password"
                                type="password"
                                className={styles.input}
                                value={formData.password}
                                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                required={!editingId}
                                placeholder={editingId ? 'Leave blank to keep current' : ''}
                            />
                        </div>
                        <div className={styles.inputGroup}>
                            <label htmlFor="user-role" className={styles.label}>Role</label>
                            <select
                                id="user-role"
                                className={styles.select}
                                value={formData.role}
                                onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                                disabled={!isAdmin}
                            >
                                <option value="VIEWER">Viewer</option>
                                <option value="EDITOR">Editor</option>
                                <option value="ADMIN">Admin</option>
                            </select>
                        </div>
                        <button type="submit" className={styles.addButton} disabled={loading}>
                            {loading ? 'Saving...' : editingId ? 'Update User' : 'Create User'}
                        </button>
                    </form>
                </div>
            )}

            <div className={styles.tableWrapper}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th className={styles.th}>Name</th>
                            <th className={styles.th}>Username</th>
                            <th className={styles.th}>Role</th>
                            <th className={styles.th}>Created</th>
                            <th className={styles.th}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((user) => {
                            const isSelf = user.id === sessionUser.id;
                            return (
                                <tr key={user.id}>
                                    <td className={styles.td}>
                                        <span className={styles.userCell}>
                                            <span>{user.name || '—'}</span>
                                            {isSelf && <span className={`${styles.pill} ${styles.pillAdmin}`}>You</span>}
                                        </span>
                                    </td>
                                    <td className={styles.td}>{user.username}</td>
                                    <td className={styles.td}>
                                        <span className={`${styles.pill} ${getRoleBadgeClass(user.role)}`}>
                                            {user.role}
                                        </span>
                                    </td>
                                    <td className={styles.td}>{formatDate(user.createdAt)}</td>
                                    <td className={styles.td}>
                                        <div className={styles.itemActions}>
                                            {(isAdmin || isSelf) && (
                                                <button
                                                    type="button"
                                                    className={styles.editButton}
                                                    onClick={() => handleEdit(user)}
                                                >
                                                    Edit
                                                </button>
                                            )}
                                            {isAdmin && !isSelf && (
                                                <button
                                                    type="button"
                                                    className={styles.deleteButton}
                                                    onClick={() => handleDelete(user.id)}
                                                >
                                                    Delete
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div className={styles.noteBanner}>
                <strong>Note:</strong> All users have unrestricted read access to view the shared household portfolio. Roles govern editing and administrative permissions.
            </div>
        </section>
    );
}
