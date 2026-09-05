/* eslint-disable @typescript-eslint/no-explicit-any */
import { auth } from "@/auth";
import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

export async function GET(req: Request) {
    const session = await auth();
    if (!session) {
        return new NextResponse("Unauthorized", { status: 401 });
    }

    const userRole = (session.user as any).role;
    const userId = session.user?.id;

    try {
        let whereClause: any = { id: userId };

        // If ADMIN or EDITOR, remove the restriction (return all users)
        if (userRole === 'ADMIN' || userRole === 'EDITOR') {
            whereClause = {};
        }

        const users = await prisma.user.findMany({
            where: whereClause,
            select: {
                id: true,
                username: true,
                name: true,
                role: true,
                createdAt: true,
                aiEnabled: true,
            },
            orderBy: { createdAt: 'desc' }
        });
        return NextResponse.json(users);
    } catch (error) {
        console.error("Error fetching users:", error);
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}

export async function POST(req: Request) {
    const session = await auth();
    if (!session || (session.user as any).role !== 'ADMIN') {
        return new NextResponse("Unauthorized", { status: 401 });
    }

    try {
        const { username, password, role, name, aiEnabled } = await req.json();

        if (!username || !password || !role) {
            return new NextResponse("Missing required fields", { status: 400 });
        }

        const existingUser = await prisma.user.findUnique({
            where: { username }
        });

        if (existingUser) {
            return new NextResponse("Username already exists", { status: 400 });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = await prisma.user.create({
            data: {
                username,
                password: hashedPassword,
                role,
                name,
                aiEnabled: aiEnabled ?? true // Default to true if not provided (though handled by schema default too)
            }
        });

        return NextResponse.json({
            id: user.id,
            username: user.username,
            role: user.role
        });
    } catch (error) {
        console.error("Error creating user:", error);
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}
