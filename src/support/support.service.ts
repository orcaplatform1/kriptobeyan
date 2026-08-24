import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupportTicketStatus } from '../../generated/prisma/client';

const TICKET_INCLUDE = {
  messages: { orderBy: { createdAt: 'asc' as const } },
};

@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  async createTicket(userId: string, subject: string, body: string) {
    return this.prisma.supportTicket.create({
      data: {
        userId,
        subject,
        messages: {
          create: { senderUserId: userId, isFromStaff: false, body },
        },
      },
      include: TICKET_INCLUDE,
    });
  }

  listForUser(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: TICKET_INCLUDE,
    });
  }

  async getOwnedTicket(userId: string, ticketId: string, isAdmin = false) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: TICKET_INCLUDE,
    });
    if (!ticket || (!isAdmin && ticket.userId !== userId)) {
      throw new NotFoundException('Destek bileti bulunamadı');
    }
    return ticket;
  }

  async addMessage(
    userId: string,
    ticketId: string,
    body: string,
    isFromStaff: boolean,
  ) {
    await this.getOwnedTicket(userId, ticketId, isFromStaff);
    await this.prisma.supportMessage.create({
      data: { ticketId, senderUserId: userId, isFromStaff, body },
    });
    // Kullanici yeni mesaj yazinca bilet tekrar OPEN'a donsun (staff
    // cozdum deyip kapatmis olabilir, kullanici hala sorun yasiyor demektir).
    // Staff yazarsa IN_PROGRESS'e gecer.
    await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: isFromStaff ? 'IN_PROGRESS' : 'OPEN' },
    });
    return this.getOwnedTicket(userId, ticketId, isFromStaff);
  }

  listForAdmin(status?: SupportTicketStatus) {
    return this.prisma.supportTicket.findMany({
      where: status ? { status } : {},
      orderBy: { updatedAt: 'desc' },
      include: {
        ...TICKET_INCLUDE,
        user: { select: { id: true, email: true, username: true } },
      },
    });
  }

  async updateStatus(ticketId: string, status: SupportTicketStatus) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Destek bileti bulunamadı');
    return this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status },
    });
  }
}
