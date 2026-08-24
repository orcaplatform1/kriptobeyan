import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { AdminAnnouncementsController } from './admin-announcements.controller';

@Module({
  controllers: [NotificationsController, AdminAnnouncementsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
