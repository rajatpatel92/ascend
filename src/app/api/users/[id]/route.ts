/* eslint-disable @typescript-eslint/no-explicit-any */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    if (!session || (session.user as any).role !== 'ADMIN') {
        return new NextResponse("Unauthorized", { status: 401 });
    }

    const { id } = await params;

    try {
        // Prevent deleting self
        if (session.user?.id === id) {
            return new NextResponse("Cannot delete yourself", { status: 400 });
        }

        await prisma.user.delete({
            where: { id }
        });


        return new NextResponse(null, { status: 204 });
    } catch (error) {
        console.error("Error deleting user:", error);
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const { id } = await params;

    if (!session || ((session.user as any).role !== 'ADMIN' && session.user?.id !== id)) {
        return new NextResponse("Unauthorized", { status: 401 });
    }

    try {
        const { name, password, role, aiEnabled } = await req.json();

        const updateData: any = {};
        if (name !== undefined) updateData.name = name;
        if (aiEnabled !== undefined) updateData.aiEnabled = aiEnabled;

        if (role) {
            if ((session.user as any).role !== 'ADMIN') {
                return new NextResponse("Unauthorized to change role", { status: 403 });
            }
            updateData.role = role;
        }

        if (password) {
            updateData.password = await bcrypt.hash(password, 10);
        }

        await prisma.user.update({
            where: { id },
            data: updateData
        });

        return new NextResponse(null, { status: 200 });
    } catch (error) {
        console.error("Error updating user:", error);
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}
