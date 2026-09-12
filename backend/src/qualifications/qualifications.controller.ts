import { Controller, Get } from '@nestjs/common';
import { QualificationsService } from './qualifications.service';

@Controller({ path: 'qualifications', version: '1' })
export class QualificationsController {
  constructor(private readonly qualificationsService: QualificationsService) {}

  @Get()
  findAll() {
    return this.qualificationsService.findAll();
  }
}
