import { Module } from '@nestjs/common';
import { ExpertsService } from './experts.service';
import { ExpertsController } from './experts.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Expert } from './entities/expert.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Expert])],
  controllers: [ExpertsController],
  providers: [ExpertsService],
})
export class ExpertsModule {}
