import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { authConfig } from './auth.config';

const prisma = new PrismaClient();

export const { handlers, signIn, signOut, auth } = NextAuth({
    ...authConfig,
    providers: [
        Credentials({
            credentials: {
                username: { label: "Username", type: "text" },
                password: { label: "Password", type: "password" }
            },
            authorize: async (credentials) => {
                if (!credentials?.username || !credentials?.password) return null;

                const username = credentials.username as string;
                const password = credentials.password as string;

                const user = await prisma.user.findUnique({ where: { username } });

                if (!user) return null;

                const passwordsMatch = await bcrypt.compare(password, user.password);
                if (passwordsMatch) return user;

                return null;
            },
        }),
    ],
    logger: {
        error(code, ...message) {
            console.error(`[Auth Error] ${code}:`, ...message);
        },
        warn(code, ...message) {
            console.warn(`[Auth Warning] ${code}:`, ...message);
        },
        debug(code, ...message) {
            // Optional: console.log(`[Auth Debug] ${code}:`, ...message);
        },
    },
});
