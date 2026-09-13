import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Qualification } from './entities/qualification.entity';
import { Repository } from 'typeorm';

@Injectable()
export class QualificationsService {
  constructor(
    @InjectRepository(Qualification)
    private qualificationRepository: Repository<Qualification>,
  ) {}

  findAll() {
    return this.qualificationRepository.find();
  }
}
